/**
 * 로그에 남길 민감 문자열을 앞뒤 일부만 보이도록 줄인다.
 * @param {string} value - 마스킹할 문자열
 * @returns {string} 마스킹된 문자열
 */
export function redact(value) {
  if (!value) return value;
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

/**
 * Set-Cookie 치환 콜백에서 쿠키 값만 마스킹한다.
 * @param {string} match - 정규식 전체 매치
 * @param {string} key - 쿠키 키
 * @param {string} cookieValue - 쿠키 값
 * @returns {string} 마스킹된 쿠키 할당 문자열
 */
export function redactCookieAssignment(match, key, cookieValue) {
  return `${key}=${redact(cookieValue)}`;
}

/**
 * Set-Cookie header의 민감 값을 마스킹한다.
 * @param {string} value - Set-Cookie header 값
 * @returns {string} 마스킹된 Set-Cookie header 값
 */
export function redactSetCookie(value) {
  return value.replace(/^([^=]+)=([^;]*)/, redactCookieAssignment);
}

/**
 * 단일 또는 다중 Set-Cookie header를 배열로 정규화한다.
 * @param {string|string[]} value - Set-Cookie header 값
 * @returns {string[]} Set-Cookie header 배열
 */
export function normalizeSetCookie(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * CLI 미리보기에서 긴 인자를 줄인다.
 * @param {string} value - CLI 인자 값
 * @returns {string} 축약된 인자 값
 */
export function maskArg(value) {
  if (value.length <= 24) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

/**
 * 실행할 CLI 명령을 로그용 문자열로 만든다.
 * @param {string} command - CLI 명령 이름
 * @param {string[]} args - CLI 인자 목록
 * @returns {string} 로그용 명령 문자열
 */
export function formatCommandPreview(command, args) {
  return [command, ...args.map(maskArg)].join(" ");
}
