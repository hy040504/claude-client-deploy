import { runClientPrompt } from "../src/prompts/client-prompt.js";

try {
  await runClientPrompt();
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
