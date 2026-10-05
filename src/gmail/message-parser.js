/**
 * 본문과 버튼 링크를 한 번에 읽고, MIME 순서와 관계없이 일반 텍스트를 우선 사용한다.
 * @param {object} payload - Gmail이 반환한 메일 본문과 MIME 하위 항목
 * @returns {{text: string, links: object[]}} 읽기용 본문과 중복 제거한 HTML 링크
 */
export function extractMessageContent(payload) {
  const plainTexts = [];
  const htmlTexts = [];
  const links = [];
  visit(payload);
  const texts = plainTexts.length ? plainTexts : htmlTexts;
  return { text: texts.join("\n\n"), links: dedupeLinks(links) };

  /**
   * 첨부 파일은 제외하고 본문 MIME 항목에서 텍스트와 링크를 함께 모은다.
   * @param {object} node - 현재 확인할 MIME 항목
   * @returns {void} 반환값 없음
   */
  function visit(node) {
    if (!node || typeof node !== "object" || node.filename) return;
    const mimeType = String(node.mimeType || "").toLowerCase();
    const bodyText = decodeMessageBody(node.body).trim();
    if (mimeType === "text/plain" && bodyText) plainTexts.push(bodyText);
    if (mimeType === "text/html" && bodyText) {
      const text = stripHtmlTags(bodyText);
      if (text) htmlTexts.push(text);
      links.push(...extractHtmlLinks(bodyText));
    }
    for (const part of node.parts || []) visit(part);
  }
}

/**
 * 메일 본문만 필요한 호출자를 위해 읽기용 텍스트를 반환한다.
 * @param {object} payload - Gmail 메일의 본문 구조
 * @returns {string} 일반 텍스트 또는 HTML에서 추출한 본문
 */
export function extractMessageText(payload) {
  return extractMessageContent(payload).text;
}

/**
 * 일반 텍스트에서 사라지는 로그인 버튼의 URL을 HTML 본문에서 읽는다.
 * @param {object} payload - Gmail 메일의 본문 구조
 * @returns {object[]} 중복 제거된 링크 목록
 */
export function extractMessageLinks(payload) {
  return extractMessageContent(payload).links;
}

/**
 * Claude 보안 버튼처럼 anchor로만 제공되는 URL을 추출한다.
 * @param {string} html - HTML 문자열
 * @returns {object[]} 링크 목록
 */
export function extractHtmlLinks(html) {
  const links = [];
  const anchorPattern = /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html))) {
    const url = decodeHtmlEntities(match[2]).trim();
    const text = stripHtmlTags(match[3]).trim();
    if (url) links.push({ text, url });
  }

  return links;
}

/**
 * 같은 버튼이 여러 MIME part에 반복될 수 있어 URL 기준으로 정리한다.
 * @param {object[]} links - 링크 목록
 * @returns {object[]} 중복 제거된 링크 목록
 */
export function dedupeLinks(links) {
  const unique = new Map();
  for (const link of links) {
    if (!link?.url || unique.has(link.url)) continue;
    unique.set(link.url, link);
  }
  return [...unique.values()];
}

/**
 * Gmail 메시지 본문을 디코딩한다.
 * @param {object} body - Gmail body 객체
 * @returns {string} 디코딩된 본문
 */
export function decodeMessageBody(body) {
  const data = body?.data;
  if (!data || typeof data !== "string") return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/**
 * HTML fallback 본문을 사람이 읽을 수 있는 텍스트로 낮춘다.
 * @param {string} html - HTML 문자열
 * @returns {string} 태그가 제거된 텍스트
 */
export function stripHtmlTags(html) {
  return decodeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * 링크 URL과 버튼 텍스트 비교가 깨지지 않도록 기본 entity를 복원한다.
 * @param {string} value - HTML entity가 포함된 문자열
 * @returns {string} 디코딩된 문자열
 */
export function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Gmail message header 값을 찾는다.
 * @param {object[]} headers - Gmail header 배열
 * @param {string} name - 찾을 header 이름
 * @returns {string} header 값 또는 빈 문자열
 */
export function getHeader(headers, name) {
  const normalized = String(name || "").toLowerCase();
  const header = (headers || []).find(item => String(item?.name || "").toLowerCase() === normalized);
  return header?.value || "";
}

/**
 * Gmail 메시지에서 Claude 관련 메일인지 판단한다.
 * @param {object} mail - 정규화된 메일 정보
 * @returns {boolean} Claude 메일 여부
 */
export function isClaudeMail(mail) {
  const haystack = [mail.from, mail.subject, mail.snippet, mail.text, ...(mail.links || []).map(link => link.url)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes("claude") || haystack.includes("anthropic");
}
