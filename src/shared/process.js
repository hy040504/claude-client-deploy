/**
 * 값을 보기 좋은 JSON으로 출력한다.
 * @param {unknown} value - 출력할 값
 * @returns {void} 반환값 없음
 */
export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * 필수 값이 비어 있으면 명확한 오류를 던진다.
 * @param {unknown} value - 검사할 값
 * @param {string} name - 오류 메시지에 사용할 이름
 * @returns {void} 반환값 없음
 * @throws {Error} 필수 값이 없을 때 발생
 */
export function requireValue(value, name) {
  if (!value) throw new Error(`${name} is required`);
}
