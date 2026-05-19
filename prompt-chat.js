import { runChatPrompt } from "./src/prompts/chat-prompt.js";
import { shutdownCycleTls } from "./src/http/cycletls-client.js";
import chalk from "chalk";

try {
  await runChatPrompt();
} catch (error) {
  console.error(chalk.red(error?.stack || error?.message || error));
  process.exitCode = 1;
} finally {
  await shutdownCycleTls();
}
