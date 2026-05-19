import { createGmailClient, extractMessageLinks, extractMessageText, getHeader, isClaudeMail } from "./gmail-client.js";

/**
 * Gmail에서 Claude가 보낸 가장 최근 메일을 찾고 본문을 추출한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} [options={}] - 검색 옵션
 * @param {string} [options.query] - Gmail 검색 쿼리
 * @param {number} [options.maxResults] - 확인할 최대 메일 수
 * @param {boolean} [options.allowMissing=false] - 메일이 없을 때 null을 반환할지 여부
 * @returns {Promise<object>} 최신 Claude 메일 요약
 * @throws {Error} Gmail 인증 실패 또는 메일을 찾지 못했을 때 발생
 */
export async function findLatestClaudeMail(config, options = {}) {
  const { gmail, userId } = createGmailClient(config);
  const query = options.query || config.gmailClaudeQuery || "newer_than:30d";
  const maxResults = Number.isInteger(options.maxResults) ? options.maxResults : config.gmailClaudeMaxResults || 20;

  const list = await gmail.users.messages.list({
    userId,
    q: query,
    maxResults,
    includeSpamTrash: false
  });

  const messages = list.data.messages || [];
  for (const item of messages) {
    const message = await gmail.users.messages.get({
      userId,
      id: item.id,
      format: "full"
    });

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
  const text = extractMessageText(message?.payload);
  const links = extractMessageLinks(message?.payload);

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

  const patterns = [
    /\b(\d{6})\b/,
    /\b(\d{5})\b/
  ];

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
    const haystack = `${link.text || ""} ${link.url || ""}`.toLowerCase();
    return (
      haystack.includes("login") ||
      haystack.includes("로그인") ||
      haystack.includes("verify") ||
      haystack.includes("verification") ||
      haystack.includes("claude.ai")
    );
  });
}
