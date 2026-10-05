import { runTuiSession } from "../src/chat/session-tui.js";

Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
Object.defineProperty(process.stdout, "columns", { value: 90 });
Object.defineProperty(process.stdout, "rows", { value: 30 });
/**
 * 모의 터미널에서 실제 콘솔 모드를 바꾸지 않도록 호출만 받아 준다.
 * @returns {void} 반환값 없음
 */
process.stdin.setRawMode = () => {};

const calls = [];
const runtime = {
  config: { accountId: "mock", defaultModel: "test-model" },
  api: {
    /**
     * 실제 API 요청 없이 새 대화 생성 호출을 기록한다.
     * @param {...unknown} args - TUI가 전달한 API 인자
     * @returns {Promise<object>} 첫 답변을 흉내 낸 결과
     */
    createChat: async (...args) => {
      calls.push({ name: "create", args });
      return { conversationId: "conversation", assistantMessageUuid: "assistant-1", assistantText: "테스트 응답" };
    },
    /**
     * 이어쓰기의 부모 메시지와 인자를 확인할 수 있도록 호출을 기록한다.
     * @param {...unknown} args - TUI가 전달한 API 인자
     * @returns {Promise<object>} 후속 답변을 흉내 낸 결과
     */
    sendChatMessage: async (...args) => {
      calls.push({ name: "send", args });
      return { conversationId: "conversation", assistantMessageUuid: "assistant-2", assistantText: "두 번째 응답" };
    }
  },
  /**
   * 종료 시 쿠키 저장이 호출되었는지 기록한다.
   * @returns {number} 기록 후 호출 목록 길이
   */
  persistJar: () => calls.push({ name: "persistJar" }),
  /**
   * 종료 시 브라우저 상태 저장이 호출되었는지 기록한다.
   * @returns {number} 기록 후 호출 목록 길이
   */
  persistState: () => calls.push({ name: "persistState" })
};

/**
 * 네트워크 없이 TUI의 실제 키 입력 경로를 실행한다.
 * @param {string} text - 입력할 메시지
 * @returns {void} 반환값 없음
 */
function typeMessage(text) {
  process.stdin.emit("keypress", text, {});
  setTimeout(() => process.stdin.emit("keypress", "\r", { name: "return" }), 280);
}

const timers = [
  setTimeout(() => typeMessage("안녕하세요"), 50),
  setTimeout(() => typeMessage("이어서 질문"), 1000),
  setTimeout(() => typeMessage("/quit"), 2100)
];
try {
  const result = await runTuiSession({ mode: "new", runtime });
  console.log(`TUI_RESULT=${JSON.stringify({ result, calls })}`);
} finally {
  for (const timer of timers) clearTimeout(timer);
}
