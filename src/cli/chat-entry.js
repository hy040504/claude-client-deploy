import chalk from "chalk";
import { runChatMenu } from "../chat/menu.js";
import { shutdownCycleTls } from "../http/cycletls-client.js";

/**
 * 채팅 실행 파일의 오류 처리와 HTTP 자원 정리를 통일한다.
 * @param {string} presentation - cli 또는 tui 화면
 * @param {string[]} args - 실행 인자
 * @returns {Promise<void>} 실행 종료
 */
export async function runChatEntry(presentation, args = process.argv.slice(2)) {
  try {
    await runChatMenu(args, { presentation });
  } catch (error) {
    console.error(chalk.red(error?.message || String(error)));
    process.exitCode = 1;
  } finally {
    await shutdownCycleTls();
  }
}
