import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromProjectRoot } from "../src/shared/paths.js";
import { extractMessagesFromConversation, findLatestAssistantMessageUuid } from "../src/chat/conversation-data.js";

test("공유 대화 파서는 메시지와 다음 parent UUID를 복원한다", () => {
  const conversation = {
    chat_messages: [
      { uuid: "user-1", sender: "human", text: "질문" },
      { uuid: "assistant-1", sender: "assistant", text: "응답" }
    ]
  };
  assert.deepEqual(extractMessagesFromConversation(conversation), [
    { role: "user", text: "질문" },
    { role: "assistant", text: "응답" }
  ]);
  assert.equal(findLatestAssistantMessageUuid(conversation), "assistant-1");
});

test("모의 TTY에서 새 메시지·이어쓰기·종료·상태 저장 경로가 동작한다", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["test-support/tui-smoke.js"], {
    cwd: fromProjectRoot(),
    encoding: "utf8",
    timeout: 12000,
    windowsHide: true
  });
  const result = JSON.parse(stdout.match(/TUI_RESULT=(.*)/)[1]);
  assert.equal(result.result.quit, true);
  assert.deepEqual(
    result.calls.map(call => call.name),
    ["create", "send", "persistJar", "persistState"]
  );
  assert.equal(result.calls[1].args[2], "assistant-1");
  assert.match(stdout, /테스트 응답/);
});
