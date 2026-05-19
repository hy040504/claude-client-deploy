import { randomUInt63 } from "../shared/random.js";
import { parseCapturedHeaders } from "./captured-headers.js";

/**
 * Claude 웹 클라이언트가 보내는 형태에 맞춘 요청 header를 만든다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} state - 브라우저 식별자 상태
 * @param {string} method - HTTP 메서드
 * @param {string} referer - Referer header 값
 * @returns {object} 브라우저 유사 요청 header
 */
export function browserHeaders(config, state, method, referer) {
  const capturedHeaders = parseCapturedHeaders(config.capturedHeaders || state.capturedHeaders);
  const traceId = randomUInt63();
  const parentId = randomUInt63();
  const traceHex = traceId.toString(16).padStart(32, "0");
  const parentHex = parentId.toString(16).padStart(16, "0");

  const generatedHeaders = {
    "User-Agent": config.userAgent,
    Accept: "*/*",
    "Accept-Language": config.acceptLanguage || (config.locale === "ko-KR" ? "ko,ko-KR;q=0.9,en-US;q=0.8,en;q=0.7" : config.locale),
    "Accept-Encoding": config.acceptEncoding,
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": quoteClientHint(config.browserPlatform || "Windows"),
    "sec-ch-ua-platform-version": quoteClientHint(config.secChUaPlatformVersion || ""),
    "sec-ch-ua-full-version": '"147.0.7727.138"',
    "sec-ch-ua-full-version-list": '"Google Chrome";v="147.0.7727.138", "Not.A/Brand";v="8.0.0.0", "Chromium";v="147.0.7727.138"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-model": '""',
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "anthropic-anonymous-id": state.anonymousId,
    "x-activity-session-id": state.activitySessionId,
    "anthropic-device-id": state.deviceId,
    "anthropic-client-sha": config.clientSha,
    "anthropic-client-platform": config.clientPlatform,
    "anthropic-client-version": config.clientVersion,
    "x-datadog-trace-id": String(traceId),
    "x-datadog-parent-id": String(parentId),
    "x-datadog-origin": "rum",
    "x-datadog-sampling-priority": "1",
    traceparent: `00-${traceHex}-${parentHex}-01`,
    tracestate: "dd=s:1;o:rum",
    Referer: referer || `${config.baseUrl}/login`,
    ...(method.toUpperCase() !== "GET" ? { Origin: config.baseUrl, "Content-Type": "application/json" } : {})
  };

  if (!Object.keys(capturedHeaders).length) return generatedHeaders;

  return {
    ...generatedHeaders,
    ...capturedHeaders,
    ...(referer ? { Referer: referer } : {})
  };
}

/**
 * Client Hint 헤더가 브라우저 형식과 맞도록 값을 따옴표로 감싼다.
 * @param {string} value - 헤더 값
 * @returns {string} 따옴표로 감싼 값
 */
function quoteClientHint(value) {
  const stringValue = String(value ?? "");
  if (stringValue.startsWith('"') && stringValue.endsWith('"')) {
    return stringValue;
  }
  return `"${stringValue}"`;
}
