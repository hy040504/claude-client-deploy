import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Cookie, CookieJar } from "tough-cookie";
import { redact } from "../shared/mask.js";

/**
 * 저장된 cookie jar를 불러오고 실패 시 새 jar를 만든다.
 * @param {string} path - cookie jar 파일 경로
 * @returns {CookieJar} 복원된 cookie jar
 */
export function loadJar(path) {
  if (!existsSync(path)) return new CookieJar();

  try {
    return CookieJar.deserializeSync(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return new CookieJar();
  }
}

/**
 * cookie jar를 파일에 저장한다.
 * @param {string} path - 저장할 파일 경로
 * @param {CookieJar} cookieJar - 저장할 cookie jar
 * @returns {void} 반환값 없음
 */
export function saveJar(path, cookieJar) {
  writeFileSync(path, JSON.stringify(cookieJar.serializeSync(), null, 2));
}

/**
 * 브라우저 세션에 필요한 기본 Claude 쿠키를 jar에 심는다.
 * @param {CookieJar} cookieJar - 쿠키를 추가할 jar
 * @param {string} baseUrl - Claude 기준 URL
 * @param {object} browserState - 브라우저 식별자 상태
 * @returns {void} 반환값 없음
 */
export function seedBrowserCookies(cookieJar, baseUrl, browserState) {
  const cookies = [
    `anthropic-device-id=${browserState.deviceId}; Path=/; Secure; SameSite=Lax`,
    `activitySessionId=${browserState.activitySessionId}; Path=/; Secure; SameSite=Lax`,
    `ajs_anonymous_id=${browserState.anonymousId}; Path=/; Secure; SameSite=Lax`,
    "CH-prefers-color-scheme=light; Path=/; Secure; SameSite=Lax"
  ];

  for (const line of cookies) cookieJar.setCookieSync(line, baseUrl, { ignoreError: true });
}

/**
 * 캡처한 Cookie header를 jar에 반영한다.
 * @param {CookieJar} cookieJar - 쿠키를 추가할 jar
 * @param {string} baseUrl - Claude 기준 URL
 * @param {string} header - 캡처한 Cookie header 값
 * @returns {void} 반환값 없음
 */
export function seedCapturedCookie(cookieJar, baseUrl, header) {
  if (!header) return;

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const parsed = Cookie.parse(`${trimmed}; Domain=${new URL(baseUrl).hostname}; Path=/`);
    if (parsed) cookieJar.setCookieSync(parsed, baseUrl, { ignoreError: true });
  }
}

/**
 * 저장된 쿠키를 민감값 마스킹 후 나열한다.
 * @param {CookieJar} cookieJar - 조회할 cookie jar
 * @param {string} baseUrl - Claude 기준 URL
 * @returns {Promise<object[]>} 마스킹된 쿠키 목록
 */
export async function listCookies(cookieJar, baseUrl) {
  const cookies = await cookieJar.getCookies(baseUrl);
  return cookies.map(cookie => ({
    key: cookie.key,
    value: redact(cookie.value),
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires
  }));
}

/**
 * 쿠키 목록에서 지정한 키를 찾는다.
 * @param {object[]} cookies - 검색할 쿠키 목록
 * @param {string} key - 찾을 쿠키 키
 * @returns {object|undefined} 찾은 쿠키 또는 undefined
 */
export function findCookie(cookies, key) {
  for (const cookie of cookies) {
    if (cookie.key === key) return cookie;
  }
  return undefined;
}
