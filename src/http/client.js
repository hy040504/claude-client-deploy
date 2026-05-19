import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { acceptAnyStatus } from "../shared/http.js";
import { browserHeaders } from "./browser-headers.js";
import { createCycleTlsHttpClient } from "./cycletls-client.js";

/**
 * Claude 웹 요청과 유사한 header 및 cookie jar를 적용한 HTTP 클라이언트를 만든다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} state - 브라우저 식별자 상태
 * @param {object} cookieJar - 요청에 사용할 cookie jar
 * @param {Function} persistJar - 응답 후 cookie jar를 저장하는 함수
 * @returns {object} Axios HTTP 클라이언트
 */
export function createHttpClient(config, state, cookieJar, persistJar) {
  if (config.httpClient === "cycletls") {
    return createCycleTlsHttpClient(config, state, cookieJar, persistJar);
  }

  const http = wrapper(
    axios.create({
      baseURL: config.baseUrl,
      jar: cookieJar,
      withCredentials: true,
      timeout: config.requestTimeoutMs,
      maxRedirects: 5,
      validateStatus: acceptAnyStatus,
      decompress: true
    })
  );

  http.interceptors.request.use(request => {
    // Claude 웹 요청과 최대한 같은 fingerprint를 유지해야 Cloudflare 차단 가능성이 낮아진다.
    const existingHeaders = request.headers?.toJSON ? request.headers.toJSON() : request.headers || {};
    removeAxiosDefaultHeaders(existingHeaders);
    request.headers = {
      ...browserHeaders(config, state, request.method || "GET", existingHeaders.Referer || existingHeaders.referer),
      ...existingHeaders
    };
    return request;
  });

  http.interceptors.response.use(response => {
    // 서버가 갱신한 세션 쿠키를 다음 CLI 실행에서도 이어 쓰기 위해 즉시 저장한다.
    persistJar();
    return response;
  });

  return http;
}

/**
 * 실제 브라우저 패킷과 충돌하는 Axios 기본 헤더를 제거한다.
 * @param {object} headers - 요청 헤더 객체
 * @returns {void} 반환값 없음
 */
function removeAxiosDefaultHeaders(headers) {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "accept" && headers[name] === "application/json, text/plain, */*") {
      delete headers[name];
    }
  }
}
