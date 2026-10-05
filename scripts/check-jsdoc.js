import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fromProjectRoot } from "../src/shared/paths.js";
import { collectSourceFiles } from "./lib/source-files.js";
import { checkSourceDocumentation } from "./lib/jsdoc-analysis.js";

let count = 0;
for (const path of collectSourceFiles()) {
  for (const failure of checkSourceDocumentation(readFileSync(path, "utf8"))) {
    console.error(`${relative(fromProjectRoot(), path)}:${failure.line} ${failure.name}: ${failure.message}`);
    count += 1;
  }
}
if (count) {
  console.error(`JSDoc 검사 실패: ${count}건`);
  process.exitCode = 1;
} else {
  console.log("한국어 JSDoc·매개변수·반환값 검사 통과");
}
