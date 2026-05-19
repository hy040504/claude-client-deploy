import { randomBytes } from "node:crypto";

/**
 * Datadog trace header에 사용할 63비트 난수를 만든다.
 * @returns {bigint} 부호 없는 63비트 정수
 */
export function randomUInt63() {
  return BigInt.asUintN(63, BigInt(`0x${randomBytes(8).toString("hex")}`));
}

/**
 * Claude 메시지 UUID 형식에 맞는 UUID v7 값을 만든다.
 * @returns {string} UUID v7 문자열
 */
export function uuidV7() {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/**
 * UUID 바이트 배열을 표준 문자열 형태로 변환한다.
 * @param {Buffer} bytes - UUID 바이트 배열
 * @returns {string} UUID 문자열
 */
function formatUuid(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
