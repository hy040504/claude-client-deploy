import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createRuntime } from "../runtime/create-runtime.js";
import { loadLastChat } from "../state/last-chat.js";
import { extractMessagesFromConversation, findLatestAssistantMessageUuid } from "./conversation-data.js";

/**
 * 일반 텍스트 화면에서 선택한 계정으로 채팅을 진행한다.
 * @param {object} options - 계정 설정과 대화 선택 정보
 * @returns {Promise<void>} 채팅 종료
 * @throws {Error} 이전 대화의 parent UUID를 찾지 못하면 발생
 */
export async function runPlainSession(options) {
  const runtime = createRuntime({ config: options.config });
  const rl = createInterface({ input, output });
  const resume = options.mode === "resume" ? loadLastChat(runtime.config.lastChatPath) : null;
  let conversationId = options.conversationId || resume?.conversationId;
  let parentMessageUuid =
    options.assistantMessageUuid || (resume?.conversationId === conversationId ? resume?.assistantMessageUuid : null);
  try {
    if (options.mode === "resume" && !conversationId) {
      console.log("이어갈 저장된 대화가 없습니다.");
      return;
    }
    if (conversationId) {
      const response = await runtime.api.getChatConversation("auto", conversationId);
      for (const message of extractMessagesFromConversation(response.data)) {
        console.log(`\n${message.role === "assistant" ? "Claude" : "나"}: ${message.text}`);
      }
      parentMessageUuid = findLatestAssistantMessageUuid(response.data) || parentMessageUuid;
    }
    while (true) {
      const content = (await rl.question("\n보낼 메시지 (/exit 메뉴로)> ")).trim();
      if (content === "/exit") return;
      if (!content) continue;
      if (conversationId && !parentMessageUuid)
        throw new Error("이전 assistant 메시지를 확인하지 못했습니다. 대화를 다시 선택하세요.");
      const result = conversationId
        ? await runtime.api.sendChatMessage("auto", conversationId, parentMessageUuid, content, options.model)
        : await runtime.api.createChat("auto", content, options.model);
      conversationId = result.conversationId || conversationId;
      parentMessageUuid = result.assistantMessageUuid;
      console.log(`\nClaude: ${result.assistantText || "(빈 응답)"}`);
      if (!conversationId || !parentMessageUuid)
        throw new Error("다음 메시지에 필요한 대화 ID 또는 assistant UUID가 없습니다.");
    }
  } finally {
    rl.close();
    runtime.persistJar();
    runtime.persistState();
  }
}
