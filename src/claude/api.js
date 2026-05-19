import { randomUUID } from "node:crypto";
import { keepRawResponse, summarizeCompletion } from "./sse.js";
import { uuidV7 } from "../shared/random.js";
import { requireValue } from "../shared/process.js";
import { normalizeSetCookie, redactSetCookie } from "../shared/mask.js";
import { fromProjectRoot } from "../shared/paths.js";
import { browserFetch } from "../browser/api-session.js";
import { listCookies } from "../state/cookie-jar.js";

/**
 * Claude 웹 API 호출을 CLI가 쓰기 쉬운 메서드 묶음으로 만든다.
 * @param {object} dependencies - API 생성에 필요한 의존성
 * @returns {object} Claude API 메서드 모음
 */
export function createClaudeApi({ config, state, jar, http, saveLastChat }) {
  return {
    getAccountProfile,
    getCurrentUserAccess,
    listChatConversations,
    createChat,
    sendChatMessage,
    getChatConversation,
    generateChatTitle,
    listCookies: () => listCookies(jar, config.baseUrl),
    usage
  };

  /**
   * 현재 계정 프로필을 조회한다.
   * @returns {Promise<object>} 계정 프로필 응답 요약
   */
  async function getAccountProfile() {
    const response = await fetchAccountProfile();
    return summarizeOrBrowserFallback(response, {
      method: "GET",
      url: `${config.baseUrl}/api/account_profile`,
      headers: { Referer: `${config.baseUrl}/new` }
    });
  }

  /**
   * 현재 사용자의 조직 접근 권한을 조회한다.
   * @param {string} orgId - 조직 ID 또는 auto
   * @returns {Promise<object>} 접근 권한 응답 요약
   */
  async function getCurrentUserAccess(orgId) {
    const resolvedOrgId = await resolveOrganizationId(orgId);
    const response = await http.get(`/api/bootstrap/${resolvedOrgId}/current_user_access`, {
      headers: { Referer: `${config.baseUrl}/login` }
    });
    return summarizeOrBrowserFallback(response, {
      method: "GET",
      url: `${config.baseUrl}/api/bootstrap/${resolvedOrgId}/current_user_access`,
      headers: { Referer: `${config.baseUrl}/login` }
    });
  }

  /**
   * 새 Claude 채팅을 만들고 첫 메시지를 보낸다.
   * @param {string} orgId - 조직 ID 또는 auto
   * @param {string} prompt - 보낼 메시지
   * @param {string} model - 사용할 Claude 모델
   * @returns {Promise<object>} completion 응답 요약
   */
  async function createChat(orgId, prompt, model) {
    const resolvedOrgId = await resolveOrganizationId(orgId);
    requireValue(prompt, "prompt");

    const conversationId = randomUUID();
    const body = completionBody(config, prompt, {
      model,
      includeCreateConversationParams: true
    });

    const response = await postCompletion(resolvedOrgId, conversationId, body, `${config.baseUrl}/new`);
    const result = await summarizeCompletionOrBrowserFallback(response, conversationId, {
      method: "POST",
      url: `${config.baseUrl}/api/organizations/${resolvedOrgId}/chat_conversations/${conversationId}/completion`,
      headers: {
        Accept: "text/event-stream",
        Referer: `${config.baseUrl}/new`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    saveLastChat(result);
    return result;
  }

  /**
   * Claude 대화 목록을 조회한다.
   * @param {string} orgId - 조직 ID 또는 auto
   * @returns {Promise<object>} 대화 목록 응답 요약
   */
  async function listChatConversations(orgId) {
    const resolvedOrgId = await resolveOrganizationId(orgId);
    const response = await http.get(
      `/api/organizations/${resolvedOrgId}/chat_conversations`,
      {
        headers: { Referer: `${config.baseUrl}/recents` }
      }
    );
    return summarizeOrBrowserFallback(response, {
      method: "GET",
      url: `${config.baseUrl}/api/organizations/${resolvedOrgId}/chat_conversations`,
      headers: { Referer: `${config.baseUrl}/recents` }
    });
  }

  /**
   * 기존 Claude 채팅에 후속 메시지를 보낸다.
   * @param {string} orgId - 조직 ID 또는 auto
   * @param {string} conversationId - 대화 ID
   * @param {string} parentMessageUuid - 직전 assistant 메시지 UUID
   * @param {string} prompt - 보낼 메시지
   * @param {string} model - 사용할 Claude 모델
   * @returns {Promise<object>} completion 응답 요약
   */
  async function sendChatMessage(orgId, conversationId, parentMessageUuid, prompt, model) {
    const resolvedOrgId = await resolveOrganizationId(orgId);
    requireValue(conversationId, "conversation id");
    requireValue(parentMessageUuid, "parent message uuid");
    requireValue(prompt, "prompt");

    const body = completionBody(config, prompt, {
      model,
      parentMessageUuid,
      includeCreateConversationParams: false
    });

    const response = await postCompletion(resolvedOrgId, conversationId, body, `${config.baseUrl}/chat/${conversationId}`);
    const result = await summarizeCompletionOrBrowserFallback(response, conversationId, {
      method: "POST",
      url: `${config.baseUrl}/api/organizations/${resolvedOrgId}/chat_conversations/${conversationId}/completion`,
      headers: {
        Accept: "text/event-stream",
        Referer: `${config.baseUrl}/chat/${conversationId}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    saveLastChat(result);
    return result;
  }

  /**
   * 특정 Claude 채팅의 전체 대화 내용을 조회한다.
   * @param {string} orgId - 조직 ID 또는 auto
   * @param {string} conversationId - 대화 ID
   * @returns {Promise<object>} 대화 조회 응답 요약
   */
  async function getChatConversation(orgId, conversationId) {
    const resolvedOrgId = await resolveOrganizationId(orgId);
    requireValue(conversationId, "conversation id");

    const response = await http.get(
      `/api/organizations/${resolvedOrgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual`,
      { headers: { Referer: `${config.baseUrl}/chat/${conversationId}` } }
    );
    return summarizeOrBrowserFallback(response, {
      method: "GET",
      url: `${config.baseUrl}/api/organizations/${resolvedOrgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual`,
      headers: { Referer: `${config.baseUrl}/chat/${conversationId}` }
    });
  }

  /**
   * Claude 서버에 대화 제목 생성을 요청한다.
   * @param {string} orgId - 조직 ID 또는 auto
   * @param {string} conversationId - 대화 ID
   * @param {string} messageContent - 제목 생성 기준 메시지
   * @returns {Promise<object>} 제목 생성 응답 요약
   */
  async function generateChatTitle(orgId, conversationId, messageContent) {
    const resolvedOrgId = await resolveOrganizationId(orgId);
    requireValue(conversationId, "conversation id");
    requireValue(messageContent, "message content");

    const response = await http.post(
      `/api/organizations/${resolvedOrgId}/chat_conversations/${conversationId}/title`,
      { message_content: messageContent, recent_titles: [] },
      { headers: { Referer: `${config.baseUrl}/chat/${conversationId}` } }
    );
    return summarizeOrBrowserFallback(response, {
      method: "POST",
      url: `${config.baseUrl}/api/organizations/${resolvedOrgId}/chat_conversations/${conversationId}/title`,
      headers: {
        Referer: `${config.baseUrl}/chat/${conversationId}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message_content: messageContent, recent_titles: [] })
    });
  }

  /**
   * account_profile API를 호출한다.
   * @returns {Promise<object>} Axios 응답 객체
   */
  async function fetchAccountProfile() {
    return http.get("/api/account_profile", {
      headers: { Referer: `${config.baseUrl}/new` }
    });
  }

  /**
   * 명시 조직 ID, 쿠키, 계정 프로필 순서로 조직 ID를 결정한다.
   * @param {string} orgId - 조직 ID 또는 auto
   * @returns {Promise<string>} 해석된 조직 ID
   * @throws {Error} 조직 ID를 찾지 못할 때 발생
   */
  async function resolveOrganizationId(orgId) {
    if (orgId && orgId !== "auto") return orgId;

    const cookieOrgId = await organizationIdFromCookies();
    if (cookieOrgId) return cookieOrgId;

    const response = await fetchAccountProfile();
    const resolved = extractOrganizationId(response.data);
    if (!resolved) throw new Error("organization id를 account_profile 응답에서 찾지 못했습니다.");
    return resolved;
  }

  /**
   * 쿠키에 저장된 마지막 활성 조직 ID를 읽는다.
   * @returns {Promise<string|null>} 조직 ID 또는 null
   */
  async function organizationIdFromCookies() {
    const cookies = await jar.getCookies(config.baseUrl);
    return cookies.find(cookie => cookie.key === "lastActiveOrg")?.value || null;
  }

  /**
   * Claude completion API에 SSE 요청을 보낸다.
   * @param {string} orgId - 조직 ID
   * @param {string} conversationId - 대화 ID
   * @param {object} body - completion 요청 본문
   * @param {string} referer - Referer header 값
   * @returns {Promise<object>} Axios 응답 객체
   */
  async function postCompletion(orgId, conversationId, body, referer) {
    return http.post(
      `/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`,
      body,
      {
        headers: {
          Accept: "text/event-stream",
          Referer: referer
        },
        responseType: "text",
        transformResponse: keepRawResponse
      }
    );
  }

  /**
   * 일반 API 응답을 요약하고 Cloudflare 차단 시 브라우저 fetch로 재시도한다.
   * @param {object} response - Axios 응답 객체
   * @param {object} request - 브라우저 fallback 요청 정보
   * @returns {Promise<object>} 응답 요약
   */
  async function summarizeOrBrowserFallback(response, request) {
    if (!isCloudflareBlockedResponse(response)) return summarize(response);

    const browserResponse = await browserFetch(config, request, state);
    return summarize({
      status: browserResponse.status,
      statusText: browserResponse.statusText,
      headers: browserResponse.headers || {},
      data: parseBrowserBody(browserResponse.data, browserResponse.headers?.["content-type"])
    });
  }

  /**
   * completion 응답을 요약하고 Cloudflare 차단 시 브라우저 fetch로 재시도한다.
   * @param {object} response - Axios 응답 객체
   * @param {string} conversationId - 대화 ID
   * @param {object} request - 브라우저 fallback 요청 정보
   * @returns {Promise<object>} completion 응답 요약
   */
  async function summarizeCompletionOrBrowserFallback(response, conversationId, request) {
    if (!isCloudflareBlockedResponse(response)) {
      return {
        ...summarizeCompletion(response, conversationId),
        setCookie: normalizeSetCookie(response.headers["set-cookie"]).map(redactSetCookie)
      };
    }

    const browserResponse = await browserFetch(config, request, state);
    return {
      ...summarizeCompletion(
        {
          status: browserResponse.status,
          statusText: browserResponse.statusText,
          headers: browserResponse.headers || {},
          data: browserResponse.data
        },
        conversationId
      ),
      setCookie: []
    };
  }

  /**
   * CLI 사용법과 주요 파일 경로를 반환한다.
   * @returns {object} CLI 사용법
   */
  function usage() {
    return {
      commands: [
        "node index.js profile",
        "node index.js bootstrap [org_id|auto]",
        "node index.js chat-list [org_id|auto]",
        "node index.js chat-new [org_id|auto] <prompt> [model]",
        "node index.js chat-send [org_id|auto] <conversation_id> <parent_message_uuid> <prompt> [model]",
        "node index.js chat-get [org_id|auto] <conversation_id>",
        "node index.js chat-title [org_id|auto] <conversation_id> <message_content>",
        "node index.js logout",
        "node index.js gmail-auth",
        "node index.js gmail-latest [query] [max_results]",
        "node index.js browser-debug [launch|open-new|fetch [METHOD] [PATH_OR_URL] [BODY] [REFERER]]",
        "node index.js import-rammerhead <session-file-or-sessions-dir>",
        "node index.js seed-cookie \"a=b; c=d\"",
        "node index.js cookies"
      ],
      files: {
        cookieJar: config.jarPath,
        env: fromProjectRoot(".env")
      }
    };
  }
}

/**
 * account_profile 응답에서 첫 번째 조직 ID를 추출한다.
 * @param {object} data - account_profile 응답 데이터
 * @returns {string|null} 조직 ID 또는 null
 */
export function extractOrganizationId(data) {
  const account = data?.account || data;
  const memberships = Array.isArray(account?.memberships) ? account.memberships : [];
  return memberships[0]?.organization?.uuid || null;
}

/**
 * Claude completion API가 요구하는 요청 본문을 만든다.
 * @param {object} config - 애플리케이션 설정
 * @param {string} prompt - 사용자 메시지
 * @param {object} options - completion 생성 옵션
 * @returns {object} completion 요청 본문
 */
export function completionBody(config, prompt, options) {
  const body = {
    prompt,
    timezone: config.timezone,
    personalized_styles: defaultPersonalizedStyles(),
    locale: config.locale,
    model: options.model,
    tools: defaultChatTools(),
    turn_message_uuids: {
      human_message_uuid: uuidV7(),
      assistant_message_uuid: uuidV7()
    },
    attachments: [],
    files: [],
    sync_sources: [],
    rendering_mode: "messages"
  };

  if (options.parentMessageUuid) body.parent_message_uuid = options.parentMessageUuid;

  if (options.includeCreateConversationParams) {
    body.create_conversation_params = {
      name: "",
      model: options.model,
      include_conversation_preferences: true,
      paprika_mode: null,
      compass_mode: null,
      is_temporary: false,
      enabled_imagine: false
    };
  }

  return body;
}

/**
 * Claude 웹 기본 응답 스타일 값을 만든다.
 * @returns {object[]} 기본 personalized_styles 목록
 */
export function defaultPersonalizedStyles() {
  return [
    {
      type: "default",
      key: "Default",
      name: "Normal",
      nameKey: "normal_style_name",
      prompt: "Normal\n",
      summary: "Default responses from Claude",
      summaryKey: "normal_style_summary",
      isDefault: true
    }
  ];
}

/**
 * Claude 웹 클라이언트 기본 tool 목록을 만든다.
 * @returns {object[]} 기본 tool 목록
 */
export function defaultChatTools() {
  return [
    { type: "web_search_v0", name: "web_search" },
    { type: "artifacts_v0", name: "artifacts" },
    { type: "repl_v0", name: "repl" },
    { type: "widget", name: "weather_fetch" },
    { type: "widget", name: "recipe_display_v0" },
    { type: "widget", name: "places_map_display_v0" },
    { type: "widget", name: "message_compose_v1" },
    { type: "widget", name: "ask_user_input_v0" },
    { type: "widget", name: "recommend_claude_apps" },
    { type: "widget", name: "places_search" },
    { type: "widget", name: "fetch_sports_data" }
  ];
}

/**
 * 일반 HTTP 응답을 CLI 출력용으로 요약한다.
 * @param {object} response - Axios 응답 객체
 * @returns {object} 응답 요약
 */
export function summarize(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    requestId: response.headers["request-id"],
    setCookie: normalizeSetCookie(response.headers["set-cookie"]).map(redactSetCookie),
    data: response.data
  };
}

/**
 * Cloudflare challenge 페이지 응답인지 판단한다.
 * @param {object} response - Axios 응답 객체
 * @returns {boolean} Cloudflare 차단 응답 여부
 */
function isCloudflareBlockedResponse(response) {
  if (response?.status !== 403) return false;
  if (String(response?.headers?.server || "").toLowerCase().includes("cloudflare")) return true;
  return typeof response?.data === "string" && response.data.includes("Just a moment");
}

/**
 * 브라우저 fetch 응답 본문을 content-type에 맞게 복원한다.
 * @param {unknown} body - 브라우저 fetch 응답 본문
 * @param {string} contentType - 응답 content-type
 * @returns {unknown} 파싱된 응답 본문
 */
function parseBrowserBody(body, contentType) {
  if (typeof body !== "string") return body;
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}
