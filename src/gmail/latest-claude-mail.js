import { createGmailClient, gmailAuthMode } from "./gmail-client.js";
import { extractMessageContent, getHeader, isClaudeMail } from "./message-parser.js";
import { fetchRelayLatestMail } from "./relay-client.js";

/**
 * Gmail에서 Claude가 보낸 가장 최근 메일을 찾고 본문을 추출한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} [options={}] - 검색 옵션
 * @param {string} [options.query] - Gmail 검색 쿼리
 * @param {number} [options.maxResults] - 확인할 최대 메일 수
 * @param {boolean} [options.allowMissing=false] - 메일이 없을 때 null을 반환할지 여부
 * @returns {Promise<object|null>} 최신 Claude 메일 요약 또는 누락을 허용했을 때 null
 * @throws {Error} Gmail 인증 실패 또는 메일을 찾지 못했을 때 발생
 */
export async function findLatestClaudeMail(config, options = {}) {
  return createClaudeMailReader(config)(options);
}

/**
 * 한 번의 메일 감시 동안 OAuth 클라이언트를 재사용해 access token을 반복 발급하지 않는다.
 * @param {object} config - 감시 시작 시 고정한 계정 설정
 * @param {object} [client] - 직접 조회를 대신할 테스트용 Gmail 클라이언트
 * @returns {Function} 검색 옵션을 받아 최신 메일을 조회하는 함수
 */
export function createClaudeMailReader(config, client) {
  if (gmailAuthMode(config) === "relay") return fetchRelayLatestMail.bind(null, config);
  const directClient = client || createGmailClient(config);
  return readLatest;

  /**
   * 이미 발급받은 인증 정보를 유지하면서 메일을 검색한다.
   * @param {object} [options={}] - 검색 조건과 메일 누락 허용 여부
   * @returns {Promise<object|null>} 최신 메일 또는 null
   */
  function readLatest(options = {}) {
    return findLatestDirectMail(config, options, directClient);
  }
}

/**
 * 직접 Gmail API에서 최신 Claude 메일을 찾는다.
 * @param {object} config - 계정 설정
 * @param {object} options - 검색 옵션
 * @param {object} client - 테스트 또는 서버에서 주입할 Gmail 클라이언트
 * @returns {Promise<object|null>} 최신 메일 또는 null
 */
export async function findLatestDirectMail(config, options = {}, client = createGmailClient(config)) {
  const { gmail, userId } = client;
  const query = options.query || config.gmailClaudeQuery || "newer_than:30d";
  const maxResults = options.maxResults ?? config.gmailClaudeMaxResults ?? 20;
  const requestOptions = { timeout: config.requestTimeoutMs || 30000, signal: options.signal };

  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 500)
    throw new Error("maxResults는 1~500 사이의 정수여야 합니다.");

  const list = await gmail.users.messages.list(
    {
      userId,
      q: query,
      maxResults,
      includeSpamTrash: false
    },
    requestOptions
  );

  const messages = list.data.messages || [];
  for (const item of messages) {
    const message = await gmail.users.messages.get(
      {
        userId,
        id: item.id,
        format: "full"
      },
      requestOptions
    );

    const normalized = normalizeGmailMessage(message.data);
    if (!isClaudeMail(normalized)) continue;

    return {
      ok: true,
      query,
      messageId: normalized.messageId,
      threadId: normalized.threadId,
      internalDate: normalized.internalDate,
      from: normalized.from,
      subject: normalized.subject,
      date: normalized.date,
      snippet: normalized.snippet,
      text: normalized.text,
      links: normalized.links,
      verificationLinks: findVerificationLinks(normalized),
      verificationCode: extractVerificationCode(normalized.text || normalized.snippet)
    };
  }

  if (options.allowMissing) return null;
  throw new Error("Claude에서 보낸 최근 메일을 찾지 못했습니다.");
}

/**
 * Gmail API 응답을 CLI에서 쓰기 쉬운 형태로 정규화한다.
 * @param {object} message - Gmail message 응답
 * @returns {object} 정규화된 메일 정보
 */
export function normalizeGmailMessage(message) {
  const headers = message?.payload?.headers || [];
  const { text, links } = extractMessageContent(message?.payload);

  return {
    messageId: message?.id || "",
    threadId: message?.threadId || "",
    internalDate: Number.parseInt(message?.internalDate || "0", 10) || 0,
    from: getHeader(headers, "From"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: message?.snippet || "",
    text,
    links
  };
}

/**
 * 본문에서 인증 코드처럼 보이는 값을 찾는다.
 * @param {string} text - 검사할 본문 텍스트
 * @returns {string|null} 찾은 코드 또는 null
 */
export function extractVerificationCode(text) {
  if (!text) return null;

  const patterns = [/\b(\d{6})\b/, /\b(\d{5})\b/];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Claude 로그인에 사용할 가능성이 높은 링크를 고른다.
 * @param {object} mail - 정규화된 메일 정보
 * @returns {object[]} 인증 링크 후보 목록
 */
export function findVerificationLinks(mail) {
  return (mail.links || []).filter(link => {
    try {
      const url = new URL(link.url);
      return (
        url.protocol === "https:" &&
        url.hostname === "claude.ai" &&
        !url.username &&
        !url.password &&
        /(?:magic-link|login|verify|verification)/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  });
}
