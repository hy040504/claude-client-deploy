import { existsSync, readFileSync } from "node:fs";

/**
 * 기존 환경 변수를 덮어쓰지 않고 .env 값을 로드한다.
 * @param {string} path - .env 파일 경로
 * @returns {void} 반환값 없음
 */
export function loadDotEnv(path) {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^"(.*)"$/, "$1");

    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * 환경 변수 값을 읽고 없으면 fallback을 사용한다.
 * @param {string} name - 환경 변수 이름
 * @param {string} fallback - 기본값
 * @returns {string} 환경 변수 또는 기본값
 */
export function env(name, fallback) {
  return process.env[name] || fallback;
}
