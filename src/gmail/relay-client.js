/**
 * 원격 전송에는 HTTPS를 요구하고 로컬 개발 서버에는 HTTP를 허용한다.
 * @param {string} value - relay 주소
 * @returns {URL} 검증한 URL
 * @throws {Error} 안전한 HTTP 주소가 아니면 발생
 */
export function validateRelayUrl(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new Error("relay 주소는 HTTPS를 사용하세요. HTTP는 localhost에서만 허용됩니다.");
  }
  return url;
}

/**
 * 계정별 인증 헤더와 제한 시간을 적용해 relay에 요청한다.
 * @param {object} config - 계정 설정
 * @param {string} path - API 경로
 * @param {object} options - fetch 옵션
 * @returns {Promise<object|null>} JSON 응답
 * @throws {Error} 설정 누락, HTTP 오류 또는 잘못된 JSON이면 발생
 */
async function requestRelay(config, path, options = {}) {
  if (!config.gmailRelayServerUrl) throw new Error("GMAIL_RELAY_SERVER_URL이 필요합니다.");
  const base = validateRelayUrl(config.gmailRelayServerUrl).toString().replace(/\/$/, "");
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (config.gmailRelayApiKey) headers["x-api-key"] = config.gmailRelayApiKey;
  if (config.gmailRelaySessionToken) headers.Authorization = `Bearer ${config.gmailRelaySessionToken}`;
  const controller = new AbortController();
  const abort = controller.abort.bind(controller, options.signal?.reason);
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    controller.abort.bind(controller, new DOMException("relay 요청 제한 시간을 초과했습니다.", "TimeoutError")),
    config.requestTimeoutMs || 30000
  );
  try {
    return await readResponse();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }

  /**
   * 응답 본문까지 같은 중단 신호를 적용해 서버가 응답을 끝내지 않는 상황도 제한한다.
   * @returns {Promise<object|null>} 서버가 반환한 JSON 본문
   */
  async function readResponse() {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers,
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok)
      throw new Error(`relay 요청 실패 (${response.status}). 서버 주소와 선택한 계정의 인증 상태를 확인하세요.`);
    try {
      return await response.json();
    } catch {
      controller.signal.throwIfAborted();
      throw new Error("relay 응답이 올바른 JSON이 아닙니다.");
    }
  }
}

/**
 * 선택한 Gmail 주소의 OAuth 세션을 요청한다.
 * @param {object} config - 계정 설정
 * @returns {Promise<object>} 인증 URL과 세션 ID
 */
export async function startRelayAuthSession(config) {
  const data = await requestRelay(config, "/api/auth/start", {
    method: "POST",
    body: JSON.stringify({ delivery: "session", userEmail: config.gmailUserEmail || "" })
  });
  if (!data?.sessionId || !data?.authUrl) throw new Error("relay 인증 시작 응답에 sessionId 또는 authUrl이 없습니다.");
  const authUrl = new URL(data.authUrl);
  authUrl.search = "";
  validateRelayUrl(authUrl.toString());
  if (data.expiresInMs !== undefined && (!Number.isFinite(data.expiresInMs) || data.expiresInMs <= 0))
    throw new Error("relay 인증 만료 시간이 올바르지 않습니다.");
  return data;
}

/**
 * 생성한 relay 인증 세션의 완료 상태를 조회한다.
 * @param {object} config - 계정 설정
 * @param {string} sessionId - 인증 세션 ID
 * @returns {Promise<object>} 인증 상태
 */
export async function pollRelayAuthSession(config, sessionId) {
  const data = await requestRelay(config, `/api/auth/session/${encodeURIComponent(sessionId)}`);
  if (!data || typeof data.status !== "string") throw new Error("relay 인증 상태 응답이 올바르지 않습니다.");
  return data;
}

/**
 * 선택한 계정의 relay token으로 최신 Claude 인증 메일을 조회한다.
 * @param {object} config - 계정 설정
 * @param {object} options - 메일 검색 옵션
 * @returns {Promise<object|null>} 최신 메일 또는 null
 * @throws {Error} 인증 누락 또는 메일 응답 형식 오류 시 발생
 */
export async function fetchRelayLatestMail(config, options = {}) {
  if (!config.gmailRelaySessionToken)
    throw new Error("선택한 계정의 Gmail relay 인증이 필요합니다. gmail-auth relay를 실행하세요.");
  const maxResults = options.maxResults ?? config.gmailClaudeMaxResults ?? 20;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500)
    throw new Error("maxResults는 1~500 사이의 정수여야 합니다.");
  const params = new URLSearchParams({
    query: options.query || config.gmailClaudeQuery || "newer_than:30d",
    maxResults: String(maxResults)
  });
  if (options.allowMissing) params.set("allowMissing", "true");
  const data = await requestRelay(config, `/api/gmail/latest?${params}`, { signal: options.signal });
  if (data === null) {
    if (options.allowMissing) return null;
    throw new Error("Claude에서 보낸 최근 메일을 찾지 못했습니다.");
  }
  if (!data?.messageId || !Number.isFinite(data.internalDate) || !Array.isArray(data.verificationLinks)) {
    throw new Error("relay 메일 응답 형식이 올바르지 않습니다.");
  }
  return data;
}
