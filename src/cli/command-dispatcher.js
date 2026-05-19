import { seedCapturedCookie } from "../state/cookie-jar.js";
import { browserDebug } from "../browser/api-session.js";
import { browserHeaders } from "../http/browser-headers.js";
import { logoutClaudeSession } from "../session/logout.js";
import { importRammerheadSession } from "../session/rammerhead-import.js";
import { findLatestClaudeMail } from "../gmail/latest-claude-mail.js";
import { authorizeGmail } from "../gmail/oauth-flow.js";

/**
 * CLI 명령 이름을 런타임 API 호출로 dispatch한다.
 * @param {object} runtime - CLI 런타임 객체
 * @param {string} name - 실행할 명령 이름
 * @param {string[]} args - 명령 인자
 * @returns {Promise<object|undefined>} 명령 실행 결과
 */
export async function runCliCommand(runtime, name, args) {
  const { api, config, jar, persistJar, persistState, state } = runtime;

  switch (name) {
    case "profile":
      return api.getAccountProfile();
    case "bootstrap":
      return api.getCurrentUserAccess(args[0] || config.orgId || "auto");
    case "chat-list":
      return api.listChatConversations(args[0] || config.orgId || "auto");
    case "chat-new":
      return api.createChat(...chatNewArgs(config, args));
    case "chat-send":
      return api.sendChatMessage(...chatSendArgs(config, args));
    case "chat-get":
      return api.getChatConversation(...chatGetArgs(config, args));
    case "chat-title":
      return api.generateChatTitle(...chatTitleArgs(config, args));
    case "cookies":
      return api.listCookies();
    case "seed-cookie":
      seedCapturedCookie(jar, config.baseUrl, args.join(" "));
      persistJar();
      return { ok: true, cookies: await api.listCookies() };
    case "import-rammerhead": {
      const result = await importRammerheadSession({
        config,
        jar,
        state,
        inputPath: args[0],
      });
      persistJar();
      persistState();
      return result;
    }
    case "logout":
      return logoutClaudeSession(config);
    case "gmail-latest":
      return findLatestClaudeMail(config, {
        query: args[0],
        maxResults: Number.parseInt(args[1] || String(config.gmailClaudeMaxResults || 20), 10)
      });
    case "gmail-auth":
      return authorizeGmail(config);
    case "browser-debug":
      return runBrowserDebugCommand(config, state, args);
    case "help":
    default:
      return api.usage();
  }
}

/**
 * 새 채팅 명령 인자를 API 호출 인자로 정규화한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string[]} args - CLI 인자
 * @returns {string[]} createChat 호출 인자
 */
export function chatNewArgs(config, args) {
  if (isExplicitOrgArg(args[0])) return [args[0], args[1], args[2] || config.defaultModel];
  return [config.orgId || "auto", args[0], args[1] || config.defaultModel];
}

/**
 * 채팅 전송 명령 인자를 API 호출 인자로 정규화한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string[]} args - CLI 인자
 * @returns {string[]} sendChatMessage 호출 인자
 */
export function chatSendArgs(config, args) {
  if (isExplicitOrgArg(args[0])) {
    return [args[0], args[1], args[2], args[3], args[4] || config.defaultModel];
  }
  return [config.orgId || "auto", args[0], args[1], args[2], args[3] || config.defaultModel];
}

/**
 * 채팅 조회 명령 인자를 API 호출 인자로 정규화한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string[]} args - CLI 인자
 * @returns {string[]} getChatConversation 호출 인자
 */
export function chatGetArgs(config, args) {
  if (isExplicitOrgArg(args[0])) return [args[0], args[1]];
  return [config.orgId || "auto", args[0]];
}

/**
 * 제목 생성 명령 인자를 API 호출 인자로 정규화한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string[]} args - CLI 인자
 * @returns {string[]} generateChatTitle 호출 인자
 */
export function chatTitleArgs(config, args) {
  if (isExplicitOrgArg(args[0])) return [args[0], args[1], args[2]];
  return [config.orgId || "auto", args[0], args[1]];
}

/**
 * 첫 번째 인자가 명시적 조직 ID인지 판단한다.
 * @param {string} value - 검사할 CLI 인자
 * @returns {boolean} 조직 ID 또는 auto 여부
 */
export function isExplicitOrgArg(value) {
  return value === "auto" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || "");
}

/**
 * 실제 브라우저 fallback 동작을 CLI에서 점검한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} state - 브라우저 식별자 상태
 * @param {string[]} args - browser-debug CLI 인자
 * @returns {Promise<object>} 디버그 결과
 * @throws {Error} 지원하지 않는 browser-debug 형식일 때 발생
 */
async function runBrowserDebugCommand(config, state, args) {
  const mode = args[0] || "fetch";

  if (mode === "launch" || mode === "open-new") {
    return browserDebug(config, state, mode);
  }

  if (mode === "fetch") {
    const method = (args[1] || "GET").toUpperCase();
    const inputUrl = args[2] || "/api/account_profile";
    const body = args[3];
    const referer = args[4] || `${config.baseUrl}/new`;
    const url = inputUrl.startsWith("http") ? inputUrl : `${config.baseUrl}${inputUrl.startsWith("/") ? "" : "/"}${inputUrl}`;
    const headers = browserHeaders(config, state, method, referer);

    if (method === "GET") delete headers["Content-Type"];
    if (body === undefined) delete headers.Origin;

    return browserDebug(config, state, mode, {
      method,
      url,
      headers,
      body
    });
  }

  throw new Error("Usage: node index.js browser-debug [launch|open-new|fetch [METHOD] [PATH_OR_URL] [BODY] [REFERER]]");
}
