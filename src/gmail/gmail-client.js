import { google } from "googleapis";

/**
 * Gmail API 클라이언트를 만든다.
 * @param {object} config - 애플리케이션 설정
 * @returns {{ gmail: import("googleapis").gmail_v1.Gmail, userId: string }} Gmail 클라이언트와 사용자 ID
 * @throws {Error} OAuth 자격 증명이 부족할 때 발생
 */
export function createGmailClient(config) {
  const { clientId, clientSecret, refreshToken } = readGmailCredentials(config);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return {
    gmail: google.gmail({ version: "v1", auth: oauth2Client }),
    userId: config.gmailUserEmail || "me"
  };
}

/**
 * Gmail OAuth 클라이언트 ID와 secret을 읽는다.
 * @param {object} config - 애플리케이션 설정
 * @returns {{ clientId: string, clientSecret: string }} Gmail OAuth 클라이언트 자격 증명
 * @throws {Error} 필수 클라이언트 자격 증명이 없을 때 발생
 */
export function readGmailClientCredentials(config) {
  const clientId = config.gmailClientId || process.env.GMAIL_CLIENT_ID || "";
  const clientSecret = config.gmailClientSecret || process.env.GMAIL_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    throw new Error("Gmail OAuth 토큰을 발급하려면 GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET이 필요합니다.");
  }

  return { clientId, clientSecret };
}

/**
 * Gmail OAuth 자격 증명을 읽는다.
 * @param {object} config - 애플리케이션 설정
 * @returns {{ clientId: string, clientSecret: string, refreshToken: string }} Gmail OAuth 자격 증명
 * @throws {Error} 필수 자격 증명이 없을 때 발생
 */
export function readGmailCredentials(config) {
  const { clientId, clientSecret } = readGmailClientCredentials(config);
  const refreshToken = config.gmailRefreshToken || process.env.GMAIL_REFRESH_TOKEN || "";

  if (!refreshToken) {
    throw new Error("Gmail API를 사용하려면 GMAIL_REFRESH_TOKEN이 필요합니다. 먼저 node index.js gmail-auth를 실행하세요.");
  }

  return { clientId, clientSecret, refreshToken };
}

/**
 * Gmail 메시지 페이로드에서 본문 텍스트를 추출한다.
 * @param {object} payload - Gmail message payload
 * @returns {string} 추출된 본문 텍스트
 */
export function extractMessageText(payload) {
  const texts = [];
  visit(payload);
  return texts
    .map(text => text.trim())
    .filter(Boolean)
    .join("\n\n");

  /**
   * 페이로드를 재귀 순회하며 본문 후보를 수집한다.
   * @param {object} node - 순회할 payload 노드
   * @returns {void} 반환값 없음
   */
  function visit(node) {
    if (!node || typeof node !== "object") return;

    const mimeType = String(node.mimeType || "").toLowerCase();
    const bodyText = decodeMessageBody(node.body);

    if (mimeType === "text/plain" && bodyText) {
      texts.push(bodyText);
    } else if (mimeType === "text/html" && bodyText && texts.length === 0) {
      texts.push(stripHtmlTags(bodyText));
    }

    for (const part of node.parts || []) {
      visit(part);
    }
  }
}

/**
 * text/plain에 빠지는 버튼 URL을 보존하기 위해 HTML 링크를 추출한다.
 * @param {object} payload - Gmail message payload
 * @returns {object[]} 추출된 링크 목록
 */
export function extractMessageLinks(payload) {
  const links = [];
  visit(payload);
  return dedupeLinks(links);

  /**
   * 페이로드를 재귀 순회하며 HTML 링크를 수집한다.
   * @param {object} node - 순회할 payload 노드
   * @returns {void} 반환값 없음
   */
  function visit(node) {
    if (!node || typeof node !== "object") return;

    const mimeType = String(node.mimeType || "").toLowerCase();
    const bodyText = decodeMessageBody(node.body);

    if (mimeType === "text/html" && bodyText) {
      links.push(...extractHtmlLinks(bodyText));
    }

    for (const part of node.parts || []) {
      visit(part);
    }
  }
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
  return decodeHtmlEntities(html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
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
  const haystack = [
    mail.from,
    mail.subject,
    mail.snippet,
    mail.text,
    ...(mail.links || []).map(link => link.url)
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes("claude") || haystack.includes("anthropic");
}
