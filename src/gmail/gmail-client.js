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
 * 직접 OAuth 또는 relay 중 사용 가능한 Gmail 인증 경로가 있는지 확인한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {boolean} Gmail 인증 설정 존재 여부
 */
export function hasGmailAuth(config) {
  return gmailAuthMode(config) === "relay" ? hasRelayGmailAuth(config) : hasDirectGmailAuth(config);
}

/**
 * 로컬 OAuth 자격 증명으로 Gmail API를 직접 호출할 수 있는지 확인한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {boolean} 직접 Gmail OAuth 설정 존재 여부
 */
export function hasDirectGmailAuth(config) {
  return Boolean(config.gmailClientId && config.gmailClientSecret && config.gmailRefreshToken);
}

/**
 * relay 서버를 통해 Gmail 메일을 조회할 수 있는지 확인한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {boolean} Gmail relay 설정 존재 여부
 */
export function hasRelayGmailAuth(config) {
  return Boolean(config.gmailRelayServerUrl && config.gmailRelaySessionToken);
}

/**
 * Gmail OAuth 클라이언트 ID와 secret을 읽는다.
 * @param {object} config - 애플리케이션 설정
 * @returns {{ clientId: string, clientSecret: string }} Gmail OAuth 클라이언트 자격 증명
 * @throws {Error} 필수 클라이언트 자격 증명이 없을 때 발생
 */
export function readGmailClientCredentials(config) {
  const clientId = config.gmailClientId || "";
  const clientSecret = config.gmailClientSecret || "";

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
  const refreshToken = config.gmailRefreshToken || "";

  if (!refreshToken) {
    throw new Error(
      "Gmail API를 사용하려면 GMAIL_REFRESH_TOKEN이 필요합니다. 먼저 node index.js gmail-auth를 실행하세요."
    );
  }

  return { clientId, clientSecret, refreshToken };
}

/**
 * 사용할 메일 공급자를 확정해 다른 계정의 인증으로 fallback하지 않는다.
 * @param {object} config - 애플리케이션 설정
 * @returns {string} direct 또는 relay
 * @throws {Error} 지원하지 않는 인증 방식이면 발생
 */
export function gmailAuthMode(config) {
  const mode = config.gmailAuthMode || "direct";
  if (!["direct", "relay"].includes(mode)) throw new Error("GMAIL_AUTH_MODE는 direct 또는 relay여야 합니다.");
  return mode;
}

export { extractMessageLinks, extractMessageText, getHeader, isClaudeMail, stripHtmlTags } from "./message-parser.js";
