import { spawnSync } from "node:child_process";
import { collectSourceFiles } from "./lib/source-files.js";

for (const path of collectSourceFiles()) {
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error));
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log("JavaScript 문법 검사 통과");
