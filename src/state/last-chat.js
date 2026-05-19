import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * 이어서 대화하기에 필요한 마지막 채팅 정보를 저장한다.
 * @param {string} path - 저장할 파일 경로
 * @param {object} value - 마지막 채팅 상태
 * @returns {void} 반환값 없음
 */
export function saveLastChat(path, value) {
  if (!value?.conversationId) return;
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/**
 * 마지막 채팅 정보를 불러온다.
 * @param {string} path - 읽을 파일 경로
 * @returns {object|null} 저장된 채팅 상태 또는 없을 때 null
 */
export function loadLastChat(path) {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 마지막 채팅 정보를 삭제한다.
 * @param {string} path - 삭제할 파일 경로
 * @returns {boolean} 삭제 여부
 */
export function deleteLastChat(path) {
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
