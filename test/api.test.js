import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeApi } from "../src/claude/api.js";

/**
 * 실제 HTTP 대신 요청 경로별 모의 응답을 쓰는 API를 만든다.
 * @param {Function} get - 조회 요청을 처리할 테스트 함수
 * @param {object} [overrides={}] - 전송과 상태 저장 동작을 바꿀 의존성
 * @returns {object} 테스트용 Claude API
 */
function apiWith(get, overrides = {}) {
  return createClaudeApi({ config: { baseUrl: "https://claude.ai" }, state: {}, jar: {}, http: { get }, ...overrides });
}

/**
 * HTTP 클라이언트와 같은 응답 형태를 만든다.
 * @param {number} status - HTTP 상태 코드
 * @param {unknown} data - 응답 본문
 * @returns {object} 모의 HTTP 응답
 */
function response(status, data) {
  return { status, statusText: String(status), headers: {}, data };
}

test("v2 대화 목록의 서버 오류를 성공으로 바꾸지 않는다", async () => {
  /**
   * 구형 목록은 지원하지 않고 v2 조회는 서버 오류를 반환한다.
   * @param {string} path - 요청한 API 경로
   * @returns {Promise<object>} 실패 응답
   */
  async function get(path) {
    return response(path.includes("_v2") ? 500 : 404, {});
  }
  await assert.rejects(apiWith(get).listChatConversations("org"), /status=500/);
});

test("v2 대화 목록은 페이지와 즐겨찾기를 합치고 대화 ID 중복을 제거한다", async () => {
  const first = { uuid: "first", name: "첫 대화" };
  const second = { uuid: "second", name: "다음 대화" };
  /**
   * 두 페이지와 중복 즐겨찾기를 반환한다.
   * @param {string} path - 요청한 목록 경로
   * @returns {Promise<object>} 해당 페이지의 모의 응답
   */
  async function get(path) {
    if (!path.includes("_v2")) return response(404, {});
    const url = new URL(path, "https://claude.ai");
    if (url.searchParams.get("starred") === "true") return response(200, [first]);
    return url.searchParams.has("cursor")
      ? response(200, { items: [second], has_more: false })
      : response(200, { items: [first], has_more: true, next_cursor: "page-2" });
  }
  assert.deepEqual((await apiWith(get).listChatConversations("org")).data, [first, second]);
});

test("다음 페이지 누락·커서 반복·최대 페이지 초과 시 부분 목록을 반환하지 않는다", async () => {
  for (const mode of ["missing", "repeated", "limit"]) {
    let page = 0;
    /**
     * 끝나지 않는 페이지 응답이나 다음 커서가 누락된 응답을 만든다.
     * @param {string} path - 요청 경로
     * @returns {Promise<object>} 잘못된 페이지 응답
     */
    async function get(path) {
      if (!path.includes("_v2")) return response(404, {});
      if (path.includes("starred=true")) return response(200, []);
      return response(200, {
        items: [],
        has_more: true,
        next_cursor: mode === "missing" ? undefined : mode === "repeated" ? "same" : String(++page)
      });
    }
    await assert.rejects(apiWith(get).listChatConversations("org"), /전체 조회|최대 10페이지/);
  }
});

test("메시지 전송 실패 시 이전 답변을 조회하거나 이어쓰기 상태를 덮어쓰지 않는다", async () => {
  /**
   * 실패 이후에 호출되면 안 되는 작업을 감지한다.
   * @returns {never} 항상 테스트 실패
   */
  function unexpected() {
    assert.fail("실패 응답 이후 상태를 조회하거나 저장했습니다.");
  }
  /**
   * API의 요청 제한 응답을 재현한다.
   * @returns {Promise<object>} 실패 응답
   */
  async function post() {
    return response(429, "요청 제한");
  }
  const api = apiWith(unexpected, { http: { get: unexpected, post }, saveLastChat: unexpected });
  await assert.rejects(api.createChat("org", "질문", "model"), /status=429/);
  await assert.rejects(api.sendChatMessage("org", "chat", "parent", "질문", "model"), /status=429/);
});

test("대화 삭제에 필요한 목록도 사용자가 지정한 조직에서 조회한다", async () => {
  const seen = [];
  /**
   * 명시한 조직의 대화만 반환한다.
   * @param {string} path - 목록 요청 경로
   * @returns {Promise<object>} 대화 목록
   */
  async function get(path) {
    seen.push(path);
    return response(200, [{ uuid: "chat", name: "대화" }]);
  }
  /**
   * 실제 삭제 없이 요청 조직과 본문을 확인한다.
   * @param {string} path - 삭제 요청 경로
   * @param {object} options - 삭제 요청의 본문과 헤더
   * @returns {Promise<object>} 삭제 완료 응답
   */
  async function remove(path, options) {
    seen.push(path);
    assert.equal(options.data.uuid, "chat");
    return response(204, "");
  }
  await apiWith(get, { http: { get, delete: remove } }).deleteChatConversation("selected-org", "chat");
  assert.equal(seen.length, 2);
  assert.equal(
    seen.every(path => path.includes("/selected-org/")),
    true
  );
});
