import { runChatMenu } from "../chat/menu.js";

/**
 * 이전 모듈 경로에서 일반 텍스트 채팅 메뉴를 실행한다.
 * @param {string[]} args - 계정 및 실행 옵션
 * @returns {Promise<void>} 메뉴 종료
 */
export function runChatPrompt(args = []) {
  return runChatMenu(args, { presentation: "cli" });
}
