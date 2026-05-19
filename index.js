import { runIndexCli } from "./src/cli/index-cli.js";

try {
  await runIndexCli(process.argv);
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
} finally {
  await flushStreams();
  process.exit(process.exitCode || 0);
}

/**
 * process.exit 전에 파이프된 stdout/stderr가 잘리지 않게 비운다.
 * @returns {Promise<void>} 스트림 flush 완료
 */
async function flushStreams() {
  await new Promise(resolve => process.stdout.write("", resolve));
  await new Promise(resolve => process.stderr.write("", resolve));
}
