import { createRuntime } from "../runtime/create-runtime.js";
import { printJson } from "../shared/process.js";
import { runCliCommand } from "./command-dispatcher.js";

/**
 * CLI 인자를 해석해 명령을 실행하고 런타임 상태를 저장한다.
 * @param {string[]} argv - Node.js 프로세스 인자
 * @returns {Promise<void>} 명령 실행 완료
 */
export async function runIndexCli(argv = process.argv) {
  const runtime = createRuntime();
  const command = argv[2] || "help";
  const args = argv.slice(3);

  try {
    const result = await runCliCommand(runtime, command, args);
    if (result !== undefined) printJson(result);
  } finally {
    runtime.persistJar();
    runtime.persistState();
  }
}
