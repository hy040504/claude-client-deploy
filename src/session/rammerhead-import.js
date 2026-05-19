import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Cookie } from "tough-cookie";

const SESSION_EXTENSION = ".rhfsession";
const STATE_COOKIE_KEYS = {
  "anthropic-device-id": "deviceId",
  activitySessionId: "activitySessionId",
  ajs_anonymous_id: "anonymousId",
};
const LOGIN_COOKIE_KEYS = ["sessionKey", "routingHint", "lastActiveOrg"];

/**
 * Rammerhead 세션 파일의 Claude 쿠키를 현재 jar와 상태에 가져온다.
 * @param {object} options - import 실행 옵션
 * @returns {Promise<object>} import 결과 요약
 */
export async function importRammerheadSession({ config, jar, state, inputPath }) {
  const sessionPath = resolveSessionPath(inputPath || config.rammerheadSessionPath);
  const payload = readRammerheadSession(sessionPath);
  const hostname = new URL(config.baseUrl).hostname;
  const cookies = payload.cookies.filter((cookie) => isCookieForHostname(cookie, hostname));
  const importedNames = [];

  for (const cookieJson of cookies) {
    const cookie = Cookie.fromJSON(cookieJson);
    if (!cookie) continue;

    jar.setCookieSync(cookie, config.baseUrl, { ignoreError: true });
    importedNames.push(cookie.key);

    if (STATE_COOKIE_KEYS[cookie.key]) {
      state[STATE_COOKIE_KEYS[cookie.key]] = cookie.value;
    }
  }

  const currentCookies = await jar.getCookies(config.baseUrl);
  const currentNames = new Set(currentCookies.map((cookie) => cookie.key));

  return {
    ok: importedNames.length > 0,
    sessionPath,
    imported: importedNames.length,
    cookieNames: [...new Set(importedNames)].sort(),
    hasLoginCookies: LOGIN_COOKIE_KEYS.every((key) => currentNames.has(key)),
  };
}

/**
 * 명시 경로가 없을 때 최신 Rammerhead 세션 파일을 찾는다.
 * @param {string} path - 사용자가 지정한 세션 파일 경로
 * @returns {string} 사용할 세션 파일 경로
 * @throws {Error} 세션 파일을 찾을 수 없을 때 발생
 */
function resolveSessionPath(path) {
  if (!path) {
    throw new Error("Usage: node index.js import-rammerhead <session-file-or-sessions-dir>");
  }

  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Rammerhead session path not found: ${resolved}`);
  }

  const stats = statSync(resolved);
  if (stats.isFile()) return resolved;
  if (!stats.isDirectory()) {
    throw new Error(`Rammerhead session path must be a file or directory: ${resolved}`);
  }

  const latest = readdirSync(resolved)
    .filter((name) => name.endsWith(SESSION_EXTENSION))
    .map((name) => {
      const filePath = join(resolved, name);
      return { filePath, mtimeMs: statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  if (!latest) {
    throw new Error(`No ${SESSION_EXTENSION} files found in ${resolved}`);
  }

  return latest.filePath;
}

/**
 * Rammerhead 세션 JSON을 읽고 기본 구조를 검증한다.
 * @param {string} sessionPath - 세션 파일 경로
 * @returns {object} 파싱된 세션 데이터
 * @throws {Error} cookies 배열이 없을 때 발생
 */
function readRammerheadSession(sessionPath) {
  const parsed = JSON.parse(readFileSync(sessionPath, "utf8"));
  const serializedJar =
    typeof parsed.serializedCookieJar === "string"
      ? JSON.parse(parsed.serializedCookieJar)
      : parsed.serializedCookieJar;

  if (!Array.isArray(serializedJar?.cookies)) {
    throw new Error(`Rammerhead session does not contain serialized cookies: ${sessionPath}`);
  }

  return serializedJar;
}

/**
 * 세션 쿠키가 대상 Claude 호스트에 유효한지 확인한다.
 * @param {object} cookie - 검사할 쿠키
 * @param {string} hostname - 대상 호스트 이름
 * @returns {boolean} 대상 호스트 쿠키 여부
 */
function isCookieForHostname(cookie, hostname) {
  const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  const target = hostname.toLowerCase();
  return domain === target || target.endsWith(`.${domain}`);
}
