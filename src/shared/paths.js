import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));

export const srcDir = join(currentDir, "..");
export const projectRoot = join(srcDir, "..");

/**
 * 프로젝트 루트 기준의 절대 경로를 만든다.
 * @param {...string} parts - 루트 뒤에 붙일 경로 조각
 * @returns {string} 프로젝트 루트 기준 경로
 */
export function fromProjectRoot(...parts) {
  return join(projectRoot, ...parts);
}
