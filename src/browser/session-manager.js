/**
 * 작업 목적별 브라우저 모드를 설정값에서 선택한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string} purpose - 브라우저를 사용하는 목적
 * @param {string} fallback - 설정이 없을 때 사용할 모드
 * @returns {string} 정규화된 브라우저 모드
 */
export function resolveBrowserMode(config, purpose, fallback = "interactive") {
  const value =
    purpose === "fallback"
      ? config.browserFallbackMode
      : purpose === "debug"
        ? config.browserDebugMode
        : purpose === "login"
          ? config.browserLoginMode
          : fallback;

  return normalizeBrowserMode(value, fallback);
}

/**
 * 지원하지 않는 브라우저 모드가 들어와도 실행 가능한 값으로 되돌린다.
 * @param {string} value - 입력된 브라우저 모드
 * @param {string} fallback - 기본 브라우저 모드
 * @returns {string} background 또는 interactive
 */
export function normalizeBrowserMode(value, fallback = "interactive") {
  const normalized = String(value || fallback).toLowerCase();
  return normalized === "background" ? "background" : "interactive";
}
