import { isAbsolute, resolve } from "node:path";
import { platform } from "node:os";
import { env, loadDotEnv } from "../shared/env.js";
import { fromProjectRoot } from "../shared/paths.js";

loadDotEnv(fromProjectRoot(".env"));

const platformName = platform();
const defaultChromeExecutablePath =
  platformName === "linux"
    ? "/usr/bin/google-chrome-stable"
    : platformName === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const defaultBrowserPlatform = platformName === "linux" ? "Linux" : platformName === "darwin" ? "macOS" : "Windows";
const defaultSecChUaPlatformVersion =
  platformName === "linux" ? "" : platformName === "darwin" ? "15.0.0" : "10.0.0";
const defaultUserAgent =
  platformName === "linux"
    ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    : platformName === "darwin"
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/**
 * 설정 파일의 상대 경로를 프로젝트 루트 기준 절대 경로로 바꾼다.
 * @param {string} path - 상대 또는 절대 경로
 * @returns {string} 해석된 로컬 경로
 */
export function resolveLocalPath(path) {
  if (isAbsolute(path)) return path;
  return resolve(fromProjectRoot(), path);
}

/**
 * 환경 변수와 기본값을 합쳐 애플리케이션 설정을 만든다.
 * @returns {object} 애플리케이션 설정
 */
export function createAppConfig() {
  return {
    baseUrl: env("BASE_URL", "https://claude.ai").replace(/\/$/, ""),
    locale: env("LOCALE", "ko-KR"),
    orgId: process.env.ORG_ID,
    jarPath: resolveLocalPath(env("COOKIE_JAR_PATH", "session-cookie-jar.json")),
    statePath: resolveLocalPath(env("CLIENT_STATE_PATH", "client-state.json")),
    lastChatPath: resolveLocalPath(env("LAST_CHAT_PATH", "last-chat.json")),
    latestClaudeCodePath: resolveLocalPath(env("LATEST_CLAUDE_CODE_PATH", "tmp/latest-claude-code.json")),
    profilePath: resolveLocalPath(env("BROWSER_PROFILE_PATH", ".browser-profile")),
    rammerheadSessionPath: optionalLocalPath(env("RAMMERHEAD_SESSION_PATH", "")),
    chromeExecutablePath: env("CHROME_EXECUTABLE_PATH", defaultChromeExecutablePath),
    browserPlatform: env("BROWSER_PLATFORM", defaultBrowserPlatform),
    secChUaPlatformVersion: env("SEC_CH_UA_PLATFORM_VERSION", defaultSecChUaPlatformVersion),
    browserLoginMode: parseBrowserMode(env("BROWSER_LOGIN_MODE", "background"), "background"),
    browserFallbackMode: parseBrowserMode(env("BROWSER_FALLBACK_MODE", "background"), "background"),
    browserDebugMode: parseBrowserMode(env("BROWSER_DEBUG_MODE", "interactive"), "interactive"),
    browserInteractiveHeadless: parseHeadless(env("BROWSER_INTERACTIVE_HEADLESS", "false")),
    browserBackgroundHeadless: parseHeadless(env("BROWSER_BACKGROUND_HEADLESS", "false")),
    browserBackgroundArgs: splitArgs(env("BROWSER_BACKGROUND_ARGS", "")),
    browserNoSandbox: env("BROWSER_NO_SANDBOX", platformName === "linux" ? "true" : "false").toLowerCase() === "true",
    browserDisableXvfb: env("BROWSER_DISABLE_XVFB", "false").toLowerCase() === "true",
    browserExtraArgs: splitArgs(env("BROWSER_EXTRA_ARGS", "")),
    userAgent: env("USER_AGENT", defaultUserAgent),
    clientSha: env("ANTHROPIC_CLIENT_SHA", "1287d6df5058e3b9ed2ef2518a2cb10f8f6068af"),
    clientPlatform: env("ANTHROPIC_CLIENT_PLATFORM", "web_claude_ai"),
    clientVersion: env("ANTHROPIC_CLIENT_VERSION", "1.0.0"),
    arkosePublicKey: env("ARKOSE_PUBLIC_KEY", "EEA5F558-D6AC-4C03-B678-AABF639EE69A"),
    arkoseSite: env("ARKOSE_SITE", "https://claude.ai"),
    arkoseBaseUrl: env("ARKOSE_BASE_URL", "https://a-cdn.claude.ai").replace(/\/$/, ""),
    arkoseBuildId: env("ARKOSE_BUILD_ID", "7ecbd953-09aa-4047-9b10-febe0ed32f28"),
    arkoseSessionToken: env("ARKOSE_SESSION_TOKEN", ""),
    acceptLanguage: env("ACCEPT_LANGUAGE", ""),
    acceptEncoding: env("ACCEPT_ENCODING", "gzip, deflate, br, zstd"),
    capturedHeaders: env("CAPTURED_HEADERS", ""),
    httpClient: env("HTTP_CLIENT", "axios").toLowerCase(),
    cycleTlsJa3: env("CYCLETLS_JA3", ""),
    cycleTlsJa4r: env("CYCLETLS_JA4R", ""),
    cycleTlsHttp2Fingerprint: env("CYCLETLS_HTTP2_FINGERPRINT", "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p"),
    cycleTlsForceHttp1: env("CYCLETLS_FORCE_HTTP1", "false").toLowerCase() === "true",
    cycleTlsForceHttp3: env("CYCLETLS_FORCE_HTTP3", "false").toLowerCase() === "true",
    defaultModel: env("DEFAULT_MODEL", "claude-sonnet-4-6"),
    timezone: env("TIMEZONE", "Asia/Seoul"),
    requestTimeoutMs: Number.parseInt(env("REQUEST_TIMEOUT_MS", "30000"), 10),
    browserLoginTimeoutMs: Number.parseInt(env("BROWSER_LOGIN_TIMEOUT_MS", String(5 * 60 * 1000)), 10),
    browserLoginBackgroundTimeoutMs: Number.parseInt(env("BROWSER_LOGIN_BACKGROUND_TIMEOUT_MS", "60000"), 10),
    browserLoginPollMs: 1000,
    claudeCycleTlsLogin: env("CLAUDE_CYCLETLS_LOGIN", "true").toLowerCase() !== "false",
    claudeBrowserMagicLinkRequest: env("CLAUDE_BROWSER_MAGIC_LINK_REQUEST", "true").toLowerCase() !== "false",
    claudeBrowserMagicLinkRequestTimeoutMs: Number.parseInt(env("CLAUDE_BROWSER_MAGIC_LINK_REQUEST_TIMEOUT_MS", "60000"), 10),
    claudeLoginEmail: env("CLAUDE_LOGIN_EMAIL", env("GMAIL_USER_EMAIL", "")),
    gmailClientId: env("GMAIL_CLIENT_ID", ""),
    gmailClientSecret: env("GMAIL_CLIENT_SECRET", ""),
    gmailRefreshToken: env("GMAIL_REFRESH_TOKEN", ""),
    gmailUserEmail: env("GMAIL_USER_EMAIL", ""),
    gmailClaudeQuery: env("GMAIL_CLAUDE_QUERY", "newer_than:30d"),
    gmailClaudeMaxResults: Number.parseInt(env("GMAIL_CLAUDE_MAX_RESULTS", "20"), 10),
    gmailPollMs: Number.parseInt(env("GMAIL_POLL_MS", "10000"), 10),
    gmailOpenVerificationLink: env("GMAIL_OPEN_VERIFICATION_LINK", "true").toLowerCase() !== "false",
    gmailTryCycleTlsVerificationLink: env("GMAIL_TRY_CYCLETLS_VERIFICATION_LINK", "true").toLowerCase() !== "false",
    gmailAutoFillVerificationCode: env("GMAIL_AUTO_FILL_VERIFICATION_CODE", "true").toLowerCase() !== "false",
    gmailVerificationLinkTimeoutMs: Number.parseInt(env("GMAIL_VERIFICATION_LINK_TIMEOUT_MS", "60000"), 10),
    gmailAuthHost: env("GMAIL_AUTH_HOST", "127.0.0.1"),
    gmailAuthBindHost: env("GMAIL_AUTH_BIND_HOST", "0.0.0.0"),
    gmailAuthPort: Number.parseInt(env("GMAIL_AUTH_PORT", "3000"), 10),
    gmailAuthPath: env("GMAIL_AUTH_PATH", "/oauth2callback"),
    
    // Arkose Solver
    arkoseEnabled: env("ARKOSE_ENABLED", "true").toLowerCase() !== "false",
    arkoseSolver: env("ARKOSE_SOLVER", "azapi"),
    azapiApiKey: env("AZAPI_API_KEY", "")
  };
}

/**
 * 환경변수의 브라우저 모드 값을 허용된 값으로 제한한다.
 * @param {string} value - 입력된 브라우저 모드
 * @param {string} fallback - 기본 브라우저 모드
 * @returns {string} background 또는 interactive
 */
function parseBrowserMode(value, fallback) {
  const normalized = String(value || fallback).toLowerCase();
  if (normalized === "background" || normalized === "interactive") return normalized;
  return fallback;
}

/**
 * 문자열 환경변수를 Puppeteer headless 옵션에 맞게 변환한다.
 * @param {string} value - 환경변수 값
 * @returns {boolean|string} 변환된 headless 옵션
 */
function parseHeadless(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return value;
}

/**
 * 환경변수로 전달된 Chrome 인자 목록을 공백 기준으로 분리한다.
 * @param {string} value - 인자 문자열
 * @returns {string[]} 분리된 인자 목록
 */
function splitArgs(value) {
  return String(value || "")
    .split(/\s+/)
    .map(arg => arg.trim())
    .filter(Boolean);
}

/**
 * 선택 경로가 비어 있으면 경로 해석을 건너뛴다.
 * @param {string} path - 선택 경로
 * @returns {string} 해석된 경로 또는 빈 문자열
 */
function optionalLocalPath(path) {
  return path ? resolveLocalPath(path) : "";
}
