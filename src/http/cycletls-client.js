import initCycleTLS from "cycletls";
import { Cookie } from "tough-cookie";
import { browserHeaders } from "./browser-headers.js";
import { normalizeSetCookie } from "../shared/mask.js";

const DEFAULT_HEADER_ORDER = [
  "host",
  "connection",
  "content-length",
  "x-datadog-sampling-priority",
  "x-datadog-parent-id",
  "sec-ch-ua-platform",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-mobile",
  "x-datadog-trace-id",
  "traceparent",
  "sec-ch-ua-arch",
  "sec-ch-ua-full-version",
  "accept",
  "content-type",
  "anthropic-client-platform",
  "tracestate",
  "x-datadog-origin",
  "anthropic-device-id",
  "anthropic-anonymous-id",
  "x-activity-session-id",
  "anthropic-client-sha",
  "anthropic-client-version",
  "user-agent",
  "sec-ch-ua-platform-version",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "referer",
  "accept-encoding",
  "accept-language",
  "cookie"
];

let cycleTlsPromise = null;
const CYCLETLS_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * CycleTLS 기반 HTTP 클라이언트를 만든다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} state - 브라우저 상태
 * @param {object} cookieJar - tough-cookie jar
 * @param {Function} persistJar - cookie jar 저장 함수
 * @returns {object} Axios 호환 최소 HTTP 클라이언트
 */
export function createCycleTlsHttpClient(config, state, cookieJar, persistJar) {
  return {
    get: (url, options = {}) => request("GET", url, undefined, options),
    post: (url, body, options = {}) => request("POST", url, body, options)
  };

  /**
   * CycleTLS 요청을 실행하고 Axios 응답 형태로 변환한다.
   * @param {string} method - HTTP 메서드
   * @param {string} inputUrl - 상대 또는 절대 URL
   * @param {unknown} body - 요청 본문
   * @param {object} options - 요청 옵션
   * @returns {Promise<object>} Axios 호환 응답
   */
  async function request(method, inputUrl, body, options) {
    const url = resolveUrl(config.baseUrl, inputUrl);
    const requestHeaders = buildRequestHeaders(config, state, method, options.headers || {});
    normalizeCycleTlsAcceptEncoding(requestHeaders);
    const cookieHeader = await cookieJar.getCookieString(url);
    if (cookieHeader) requestHeaders.Cookie = cookieHeader;

    const cycleTLS = await getCycleTls(config);
    const response = await cycleTLS(url, {
      headers: requestHeaders,
      body: serializeBody(body),
      responseType: "text",
      timeout: Math.max(1, Math.ceil(config.requestTimeoutMs / 1000)),
      userAgent: requestHeaders["User-Agent"] || requestHeaders["user-agent"] || config.userAgent,
      ja3: config.cycleTlsJa3 || undefined,
      ja4r: config.cycleTlsJa4r || undefined,
      http2Fingerprint: config.cycleTlsHttp2Fingerprint || undefined,
      forceHTTP1: config.cycleTlsForceHttp1,
      forceHTTP3: config.cycleTlsForceHttp3,
      disableRedirect: false,
      enableConnectionReuse: true,
      orderAsProvided: true,
      headerOrder: headerOrder(requestHeaders)
    }, method.toLowerCase());

    const headers = normalizeResponseHeaders(response.headers);
    persistSetCookies(cookieJar, response.finalUrl || url, headers);
    persistJar();

    return {
      status: response.status,
      statusText: "",
      finalUrl: response.finalUrl || url,
      headers,
      data: parseResponseData(response.data, headers, options)
    };
  }
}

/**
 * CycleTLS JS wrapper가 zstd 본문을 문자열로 넘길 수 있어 zstd만 제외한다.
 * @param {object} headers - 요청 헤더
 * @returns {void} 반환값 없음
 */
function normalizeCycleTlsAcceptEncoding(headers) {
  let found = false;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== "accept-encoding") continue;
    headers[name] = "identity";
    found = true;
  }
  if (!found) headers["Accept-Encoding"] = "identity";
}

/**
 * CycleTLS 인스턴스를 재사용한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<Function>} CycleTLS 클라이언트
 */
async function getCycleTls(config) {
  if (!cycleTlsPromise) {
    cycleTlsPromise = initCycleTLS({
      timeout: Math.max(20000, config.requestTimeoutMs + 5000)
    });
  }
  return cycleTlsPromise;
}

/**
 * CycleTLS JS wrapper가 띄운 Go 프로세스를 종료한다.
 * @returns {Promise<void>} 종료 시도 완료
 */
export async function shutdownCycleTls() {
  if (!cycleTlsPromise) return;

  const pendingCycleTls = cycleTlsPromise;
  cycleTlsPromise = null;

  try {
    const cycleTLS = await withTimeout(
      pendingCycleTls,
      CYCLETLS_SHUTDOWN_TIMEOUT_MS,
      "CycleTLS initialization did not finish before shutdown timeout"
    );
    if (typeof cycleTLS?.exit !== "function") return;

    await withTimeout(
      cycleTLS.exit(),
      CYCLETLS_SHUTDOWN_TIMEOUT_MS,
      "CycleTLS shutdown timed out"
    );
  } catch (error) {
    console.error(`[cycletls] ${error?.message || error}`);
  }
}

/**
 * CycleTLS 작업이 무기한 대기하지 않도록 제한한다.
 * @param {Promise<*>} promise - 대기할 작업
 * @param {number} timeoutMs - 제한 시간(ms)
 * @param {string} message - timeout 오류 메시지
 * @returns {Promise<*>} 원래 작업의 결과
 */
function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/**
 * 요청 헤더를 만든다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} state - 브라우저 상태
 * @param {string} method - HTTP 메서드
 * @param {object} extraHeaders - 요청별 추가 헤더
 * @returns {object} 요청 헤더
 */
function buildRequestHeaders(config, state, method, extraHeaders) {
  const existingHeaders = normalizeHeaderObject(extraHeaders);
  removeAxiosDefaultHeaders(existingHeaders);
  return {
    ...browserHeaders(config, state, method, existingHeaders.Referer || existingHeaders.referer),
    ...existingHeaders
  };
}

/**
 * 상대 URL을 절대 URL로 바꾼다.
 * @param {string} baseUrl - 기준 URL
 * @param {string} inputUrl - 상대 또는 절대 URL
 * @returns {string} 절대 URL
 */
function resolveUrl(baseUrl, inputUrl) {
  if (String(inputUrl).startsWith("http")) return inputUrl;
  return `${baseUrl}${String(inputUrl).startsWith("/") ? "" : "/"}${inputUrl}`;
}

/**
 * 요청 본문을 CycleTLS가 받는 문자열로 변환한다.
 * @param {unknown} body - 요청 본문
 * @returns {string} 직렬화된 본문
 */
function serializeBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

/**
 * 응답 헤더를 소문자 키 중심으로 정규화한다.
 * @param {object} headers - CycleTLS 응답 헤더
 * @returns {object} 정규화된 헤더
 */
function normalizeResponseHeaders(headers) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    normalized[key] = Array.isArray(value) && value.length === 1 ? value[0] : value;
  }
  return normalized;
}

/**
 * Set-Cookie 응답을 jar에 반영한다.
 * @param {object} cookieJar - tough-cookie jar
 * @param {string} baseUrl - 기준 URL
 * @param {object} headers - 응답 헤더
 * @returns {void} 반환값 없음
 */
function persistSetCookies(cookieJar, baseUrl, headers) {
  for (const line of normalizeSetCookie(headers["set-cookie"])) {
    const parsed = Cookie.parse(line);
    if (parsed) cookieJar.setCookieSync(parsed, baseUrl, { ignoreError: true });
  }
}

/**
 * 응답 본문을 기존 Axios 경로와 같은 형태로 맞춘다.
 * @param {unknown} data - CycleTLS 응답 데이터
 * @param {object} headers - 응답 헤더
 * @param {object} options - 요청 옵션
 * @returns {unknown} 파싱된 응답 데이터
 */
function parseResponseData(data, headers, options) {
  if (options.responseType === "text") return String(data ?? "");
  const contentType = String(headers["content-type"] || "");
  if (!contentType.includes("application/json")) return data;
  if (typeof data !== "string") return data;

  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * 헤더 순서를 CycleTLS 옵션으로 만든다.
 * @param {object} headers - 요청 헤더
 * @returns {string[]} 헤더 순서
 */
function headerOrder(headers) {
  const present = new Set(Object.keys(headers).map(name => name.toLowerCase()));
  const ordered = DEFAULT_HEADER_ORDER.filter(name => present.has(name));
  for (const name of present) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

/**
 * AxiosHeaders 또는 일반 객체를 일반 객체로 정규화한다.
 * @param {object} headers - 원본 헤더
 * @returns {object} 정규화된 헤더
 */
function normalizeHeaderObject(headers) {
  return headers?.toJSON ? headers.toJSON() : { ...(headers || {}) };
}

/**
 * 실제 브라우저 패킷과 충돌하는 Axios 기본 헤더를 제거한다.
 * @param {object} headers - 요청 헤더 객체
 * @returns {void} 반환값 없음
 */
function removeAxiosDefaultHeaders(headers) {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "accept" && headers[name] === "application/json, text/plain, */*") {
      delete headers[name];
    }
  }
}
