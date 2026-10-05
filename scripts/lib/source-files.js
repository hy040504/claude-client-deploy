import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fromProjectRoot } from "../../src/shared/paths.js";

const SOURCE_DIRECTORIES = ["src", "scripts", "test", "test-support"];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

/**
 * 실행 위치에 관계없이 검사할 프로젝트 소스만 모은다.
 * @returns {string[]} 정렬된 JavaScript 파일 절대 경로
 */
export function collectSourceFiles() {
  const files = [];
  for (const directory of SOURCE_DIRECTORIES) collectDirectory(fromProjectRoot(directory), files);
  for (const entry of readdirSync(fromProjectRoot(), { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(fromProjectRoot(entry.name));
  }
  return files.sort();
}

/**
 * 지정한 소스 폴더의 하위 디렉터리까지 검사 대상에 포함한다.
 * @param {string} directory - 탐색할 절대 경로
 * @param {string[]} files - 찾은 파일을 추가할 배열
 * @returns {void} 반환값 없음
 */
function collectDirectory(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectDirectory(path, files);
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
}
