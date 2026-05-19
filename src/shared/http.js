/**
 * API 오류 응답도 fallback 판단을 위해 본문까지 받도록 허용한다.
 * @returns {boolean} 항상 true
 */
export function acceptAnyStatus() {
  return true;
}
