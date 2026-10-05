import { createRuntime } from "../runtime/create-runtime.js";
import { printJson } from "../shared/process.js";
import { runCliCommand } from "./command-dispatcher.js";
import { createAppConfig } from "../config/app-config.js";
import { parseAccountOptions } from "./account-options.js";
import { runAccountCommand } from "./account-commands.js";
import { authorizeGmail } from "../gmail/oauth-flow.js";
import { findLatestClaudeMail } from "../gmail/latest-claude-mail.js";
import { logoutClaudeSession } from "../session/logout.js";

/**
 * CLI 인자를 해석해 명령을 실행하고 런타임 상태를 저장한다.
 * @param {string[]} argv - Node.js 프로세스 인자
 * @returns {Promise<void>} 명령 실행 완료
 */
export async function runIndexCli(argv = process.argv) {
  const parsed = parseAccountOptions(argv.slice(2));
  const command = parsed.args[0] || "help";
  const args = parsed.args.slice(1);
  const config = createAppConfig({ accountId: parsed.accountId });
  if (command.startsWith("account-")) {
    printJson(runAccountCommand(config, command, args));
    return;
  }
  if (command === "gmail-auth") {
    printJson(await authorizeGmail(config, args[0]));
    return;
  }
  if (command === "gmail-latest") {
    printJson(
      await findLatestClaudeMail(config, {
        query: args[0],
        maxResults: args[1] === undefined ? undefined : Number(args[1])
      })
    );
    return;
  }
  // 로그아웃 뒤 finally에서 삭제한 쿠키를 다시 쓰지 않도록 런타임 생성을 생략한다.
  if (command === "logout") {
    printJson(await logoutClaudeSession(config));
    return;
  }
  const runtime = createRuntime({ config });

  try {
    const result = await runCliCommand(runtime, command, args);
    if (result !== undefined) printJson(result);
  } finally {
    if (command !== "help" && command !== "--help" && command !== "-h") {
      runtime.persistJar();
      runtime.persistState();
    }
  }
}
