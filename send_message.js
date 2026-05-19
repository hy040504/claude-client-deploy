import { createRuntime } from "./src/runtime/create-runtime.js";
import fs from "node:fs";

/**
 * 저장된 세션으로 Claude 대화에 테스트 메시지를 전송한다.
 * @returns {Promise<void>} 반환값 없음
 */
async function main() {
  const runtime = createRuntime();
  const { api } = runtime;
  
  const conversationId = "058acef5-5adc-47ea-85be-0ba3d81ad964";
  const parentMessageUuid = "019e21ee-a3f7-71f3-8a6f-b2a7effe1cdd";
  const prompt = "nodejs의 최신 버전은?";

  try {
    const result = await api.sendChatMessage("auto", conversationId, parentMessageUuid, prompt);
    fs.writeFileSync("second_chat_full.json", JSON.stringify(result, null, 2), "utf8");
    console.log("Saved to second_chat_full.json");
  } catch (error) {
    console.error(error);
  } finally {
    runtime.persistJar();
    runtime.persistState();
  }
}

main();
