import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 최신 Claude 인증코드 상태를 로컬 JSON 파일에 저장한다.
 * @param {string} path - 저장할 파일 경로
 * @param {object} value - 저장할 인증코드 상태
 * @returns {void} 반환값 없음
 */
export function saveLatestClaudeCode(path, value) {
  if (!path || !value?.code) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/**
 * 저장된 최신 Claude 인증코드 상태를 읽는다.
 * @param {string} path - 읽을 파일 경로
 * @returns {object|null} 저장된 상태 또는 null
 */
export function loadLatestClaudeCode(path) {
  if (!path || !existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 저장된 최신 Claude 인증코드 상태 파일을 삭제한다.
 * @param {string} path - 삭제할 파일 경로
 * @returns {boolean} 삭제 여부
 */
export function deleteLatestClaudeCode(path) {
  if (!path || !existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
