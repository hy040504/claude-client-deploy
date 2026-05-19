const UNSAFE_HEADER_NAMES = new Set([
  "content-length",
  "host",
  "cookie",
  "set-cookie",
  "referer"
]);

/**
 * 캡처한 브라우저 요청 헤더를 파싱한다.
 * JSON 객체 또는 "Header: value" 줄 목록을 지원한다.
 * @param {string} value - CAPTURED_HEADERS 값
 * @returns {object} 파싱된 헤더
 */
export function parseCapturedHeaders(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return sanitizeCapturedHeaders(value);
  }

  const input = String(value || "").trim();
  if (!input) return {};

  if (input.startsWith("{")) {
    return sanitizeCapturedHeaders(JSON.parse(input));
  }

  const headers = {};
  for (const line of input.replaceAll("\\n", "\n").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf(":");
    if (index <= 0) continue;

    const name = trimmed.slice(0, index).trim();
    const headerValue = trimmed.slice(index + 1).trim();
    if (name) headers[name] = headerValue;
  }

  return sanitizeCapturedHeaders(headers);
}

/**
 * Node axios에서 직접 보낼 수 없는 헤더를 제외한다.
 * @param {object} headers - 원본 헤더
 * @returns {object} 정리된 헤더
 */
export function sanitizeCapturedHeaders(headers) {
  const sanitized = new Map();

  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.trim();
    const lower = normalized.toLowerCase();
    if (!normalized || lower.startsWith(":")) continue;
    if (UNSAFE_HEADER_NAMES.has(lower)) continue;
    if (value === undefined || value === null) continue;
    sanitized.set(lower, [normalized, String(value)]);
  }

  return Object.fromEntries([...sanitized.values()]);
}
