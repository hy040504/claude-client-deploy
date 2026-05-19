import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * 브라우저 식별자 상태를 불러오고 손상된 경우 새 상태를 만든다.
 * @param {string} path - 상태 파일 경로
 * @returns {object} 브라우저 식별자 상태
 */
export function loadBrowserState(path) {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // 손상된 식별자를 재사용하면 세션 추적이 꼬일 수 있어 새 값으로 교체한다.
    }
  }

  return {
    deviceId: randomUUID(),
    activitySessionId: randomUUID(),
    anonymousId: `claudeai.v1.${randomUUID()}`
  };
}

/**
 * 브라우저 식별자 상태를 저장한다.
 * @param {string} path - 저장할 파일 경로
 * @param {object} value - 저장할 브라우저 식별자 상태
 * @returns {void} 반환값 없음
 */
export function saveBrowserState(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}
