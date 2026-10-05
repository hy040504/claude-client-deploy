import { withTimeout } from "../shared/async.js";
import { setTimeout as delay } from "node:timers/promises";
import { cloneBrowserProfile, connectRealBrowser, removeBrowserProfileClone } from "./real-browser.js";
import { loadJar, saveJar } from "../state/cookie-jar.js";
import { applyJarCookies, persistPageCookiesToJar } from "./cookie-sync.js";
import { sanitizeCapturedHeaders } from "../http/captured-headers.js";
import { resolveBrowserMode } from "./session-manager.js";

const BROWSER_CLOSE_TIMEOUT_MS = 5000;
const COOKIE_PERSIST_TIMEOUT_MS = 5000;

/**
 * Node HTTP 요청이 Cloudflare에 막힐 때 실제 브라우저 페이지 안에서 fetch를 실행한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} request - 브라우저에서 실행할 요청 정보
 * @param {object} state - 브라우저 상태
 * @returns {Promise<object>} 브라우저 fetch 응답 요약
 */
export async function browserFetch(config, request, state = null) {
  console.error(`[browserFetch] ${request.method} ${request.url}`);
  const mode = resolveBrowserMode(config, "fallback", "background");
  const session = await openBrowserFetchSessionWithFallback(config, mode);

  try {
    console.error(`[browserFetch] using ${session.mode} browser session`);
    return await runInPageFetch(session.page, request, state);
  } finally {
    await closeBrowserFetchSession(session);
  }
}

/**
 * 브라우저 fallback 과정을 수동으로 점검하기 위한 디버그 명령을 실행한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} state - 브라우저 상태
 * @param {string} mode - 디버그 모드
 * @param {object|null} request - fetch 모드에서 사용할 요청 정보
 * @returns {Promise<object>} 디버그 실행 결과
 * @throws {Error} 지원하지 않는 모드 또는 요청 누락 시 발생
 */
export async function browserDebug(config, state = null, mode = "fetch", request = null) {
  const normalizedMode = mode || "fetch";
  console.error(`[browserDebug] mode=${normalizedMode}`);
  const session = await openBrowserFetchSession(config, resolveBrowserMode(config, "debug", "interactive"));

  try {
    if (normalizedMode === "launch") {
      return {
        ok: true,
        mode: normalizedMode,
        pageUrl: session.page.url()
      };
    }

    if (normalizedMode === "open-new") {
      return {
        ok: true,
        mode: normalizedMode,
        pageUrl: session.page.url(),
        title: await session.page.title()
      };
    }

    if (normalizedMode === "fetch") {
      if (!request) throw new Error("browser-debug fetch mode requires a request");
      const result = await runInPageFetch(session.page, request, state);
      return {
        ok: true,
        mode: normalizedMode,
        pageUrl: session.page.url(),
        result
      };
    }

    throw new Error(`Unknown browser debug mode: ${normalizedMode}`);
  } finally {
    await closeBrowserFetchSession(session);
  }
}

/**
 * 원본 프로필의 잠금 충돌을 피하도록 복제한 프로필로 요청용 브라우저를 연다.
 * @param {object} config - 브라우저와 계정 설정
 * @param {string} mode - background 또는 interactive 실행 모드
 * @returns {Promise<object>} 브라우저와 페이지 및 정리할 임시 경로
 */
async function openBrowserFetchSession(config, mode = "background") {
  const profileClonePath = runStep("cloning browser profile", () => cloneBrowserProfile(config.profilePath));
  const jar = loadJar(config.jarPath);
  let browser;

  try {
    const connected = await runStep("launching real browser", () =>
      withTimeout(
        connectRealBrowser(config, {
          userDataDir: profileClonePath,
          mode
        }),
        90000,
        "launching real browser timed out after 90s"
      )
    );
    browser = connected.browser;
    const page = connected.page;

    await runStep("applying jar cookies", () => applyJarCookies(page, config.baseUrl, jar));
    await runStep("opening Claude", () =>
      page.goto(`${config.baseUrl}/new`, { waitUntil: "domcontentloaded", timeout: 120000 })
    );
    await delay(3000);
    await runStep("waiting for challenge clear", () => waitForChallengeClear(page));

    return { browser, page, jar, profileClonePath, config, mode };
  } catch (error) {
    if (browser) {
      await closeBrowser(browser).catch(() => {});
    }
    removeBrowserProfileClone(profileClonePath);
    throw error;
  }
}

/**
 * 백그라운드 브라우저가 막힐 때 상호작용 모드로 fetch 세션을 재시도한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string} mode - 우선 사용할 브라우저 모드
 * @returns {Promise<object>} 브라우저 fetch 세션
 */
async function openBrowserFetchSessionWithFallback(config, mode) {
  try {
    return await openBrowserFetchSession(config, mode);
  } catch (error) {
    if (mode !== "background") {
      throw error;
    }

    console.error(
      `[browserFetch] background mode failed before request, retrying interactive Chrome: ${error.message}`
    );
    const session = await openBrowserFetchSession(config, "interactive");
    console.error("[browserFetch] interactive Chrome fallback is active.");
    return session;
  }
}

/**
 * 브라우저 세션 쿠키를 저장하고 임시 프로필을 정리한다.
 * @param {object} session - 브라우저 세션 정보
 * @returns {Promise<void>} 세션 정리 완료
 */
async function closeBrowserFetchSession(session) {
  console.error("[browserFetch] closing browser");

  await runStep("persisting page cookies", () =>
    withTimeout(
      persistPageCookies(session.page, session.config, session.jar),
      COOKIE_PERSIST_TIMEOUT_MS,
      `persisting page cookies timed out after ${COOKIE_PERSIST_TIMEOUT_MS}ms`
    )
  ).catch(error => {
    console.error(`[browserFetch] ${error?.message || error}`);
  });

  await runStep("closing Chrome", () => closeBrowser(session.browser)).catch(error => {
    console.error(`[browserFetch] ${error?.message || error}`);
  });

  runStep("removing profile clone", () => removeBrowserProfileClone(session.profileClonePath));
}

/**
 * 열린 Claude 페이지 컨텍스트에서 요청을 실행한다.
 * @param {object} page - Puppeteer page 객체
 * @param {object} request - 실행할 fetch 요청 정보
 * @param {object|null} state - 브라우저 상태
 * @returns {Promise<object>} fetch 응답 요약
 */
async function runInPageFetch(page, request, state = null) {
  const headerCapture = await createRequestHeaderCapture(page, request).catch(error => {
    console.error(`[browserFetch] request header capture disabled: ${error?.message || error}`);
    return null;
  });

  let result;
  try {
    result = await runStep("running in-page fetch", () =>
      page.evaluate(async currentRequest => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        let response;
        try {
          response = await fetch(currentRequest.url, {
            method: currentRequest.method,
            headers: currentRequest.headers,
            body: currentRequest.body,
            credentials: "include",
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }

        return {
          status: response.status,
          statusText: response.statusText,
          headers: {
            "content-type": response.headers.get("content-type"),
            "request-id": response.headers.get("request-id")
          },
          data: await response.text()
        };
      }, request)
    );
  } finally {
    await persistCapturedRequestHeaders(headerCapture, state).catch(error => {
      console.error(`[browserFetch] request header capture failed: ${error?.message || error}`);
    });
  }

  console.error(`[browserFetch] completed with status ${result.status}`);
  return result;
}

/**
 * Chrome이 실제로 내보낸 API 요청 헤더를 CDP에서 캡처한다.
 * @param {object} page - Puppeteer page 객체
 * @param {object} request - 실행할 fetch 요청 정보
 * @returns {Promise<object>} 캡처 컨트롤러
 */
async function createRequestHeaderCapture(page, request) {
  const client = await page.target().createCDPSession();
  let capturedHeaders = null;
  let captured = false;
  let finalizeTimer = null;
  let resolveCaptured;
  const requestIds = new Set();
  const extraHeadersByRequestId = new Map();
  const capturedPromise = new Promise(resolve => {
    resolveCaptured = resolve;
  });

  /**
   * 기본 헤더와 추가 헤더 이벤트가 모두 도착할 여유를 둔 뒤 수집을 마친다.
   * @returns {void} 반환값 없음
   */
  const finalizeCapture = () => {
    if (!capturedHeaders) return;
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => {
      resolveCaptured(sanitizeCapturedHeaders(capturedHeaders));
    }, 150);
  };

  /**
   * 대상 URL과 메서드가 일치하는 요청의 기본 헤더를 기록한다.
   * @param {object} params - Chrome DevTools의 요청 이벤트
   * @returns {void} 반환값 없음
   */
  const onRequestWillBeSent = params => {
    if (captured && !requestIds.has(params?.requestId)) return;
    if (params?.request?.url !== request.url) return;
    if (String(params?.request?.method || "").toUpperCase() !== String(request.method || "GET").toUpperCase()) return;

    captured = true;
    requestIds.add(params.requestId);
    capturedHeaders = {
      ...(params.request.headers || {}),
      ...(extraHeadersByRequestId.get(params.requestId) || {})
    };
    finalizeCapture();
  };

  /**
   * 순서가 뒤바뀌어 도착할 수 있는 추가 헤더를 요청 ID에 맞춰 합친다.
   * @param {object} params - Chrome DevTools의 추가 헤더 이벤트
   * @returns {void} 반환값 없음
   */
  const onRequestWillBeSentExtraInfo = params => {
    if (!params?.requestId) return;
    extraHeadersByRequestId.set(params.requestId, params.headers || {});
    if (!requestIds.has(params.requestId)) return;

    capturedHeaders = {
      ...(capturedHeaders || {}),
      ...(params.headers || {})
    };
    finalizeCapture();
  };

  await client.send("Network.enable");
  client.on("Network.requestWillBeSent", onRequestWillBeSent);
  client.on("Network.requestWillBeSentExtraInfo", onRequestWillBeSentExtraInfo);

  return {
    /**
     * 헤더 수집이 끝날 때까지 제한 시간 안에서 기다린다.
     * @returns {Promise<object>} 수집한 요청 헤더
     */
    read: () => withTimeout(capturedPromise, 1500, "captured request headers were not observed"),
    /**
     * 헤더 수집 타이머와 이벤트 구독을 해제해 브라우저 종료를 막지 않도록 한다.
     * @returns {Promise<void>} 구독 해제 완료
     */
    close: async () => {
      clearTimeout(finalizeTimer);
      client.off("Network.requestWillBeSent", onRequestWillBeSent);
      client.off("Network.requestWillBeSentExtraInfo", onRequestWillBeSentExtraInfo);
      await client.detach().catch(() => {});
    }
  };
}

/**
 * 캡처한 실제 Chrome 요청 헤더를 상태에 저장한다.
 * @param {object|null} headerCapture - 캡처 컨트롤러
 * @param {object|null} state - 브라우저 상태
 * @returns {Promise<void>} 저장 완료
 */
async function persistCapturedRequestHeaders(headerCapture, state) {
  if (!headerCapture) return;

  try {
    const headers = await headerCapture.read();
    if (!state || !Object.keys(headers).length) return;

    state.capturedHeaders = headers;
    state.capturedHeadersCapturedAt = new Date().toISOString();
    console.error(`[browserFetch] captured ${Object.keys(headers).length} Chrome request headers`);
  } finally {
    await headerCapture.close();
  }
}

/**
 * 브라우저 fallback 단계별 로그와 소요 시간을 남긴다.
 * @param {string} label - 단계 이름
 * @param {Function} action - 실행할 작업
 * @returns {unknown} 작업 결과
 */
function runStep(label, action) {
  console.error(`[browserFetch] ${label}`);
  const startedAt = Date.now();
  const result = action();

  if (!isPromiseLike(result)) {
    console.error(`[browserFetch] ${label} done in ${Date.now() - startedAt}ms`);
    return result;
  }

  return result.then(
    value => {
      console.error(`[browserFetch] ${label} done in ${Date.now() - startedAt}ms`);
      return value;
    },
    error => {
      console.error(`[browserFetch] ${label} failed in ${Date.now() - startedAt}ms`);
      throw error;
    }
  );
}

/**
 * Chrome 종료가 멈추면 연결 해제와 프로세스 종료를 시도한다.
 * @param {object} browser - Puppeteer browser 객체
 * @returns {Promise<void>} 브라우저 종료 시도 완료
 */
async function closeBrowser(browser) {
  try {
    await withTimeout(
      browser.close(),
      BROWSER_CLOSE_TIMEOUT_MS,
      `closing Chrome timed out after ${BROWSER_CLOSE_TIMEOUT_MS}ms`
    );
    return;
  } catch (error) {
    console.error(`[browserFetch] ${error?.message || error}`);
  }

  try {
    if (typeof browser.disconnect === "function") browser.disconnect();
  } catch (error) {
    console.error(`[browserFetch] browser disconnect failed: ${error?.message || error}`);
  }

  try {
    const process = typeof browser.process === "function" ? browser.process() : null;
    if (process && !process.killed) process.kill();
  } catch (error) {
    console.error(`[browserFetch] browser process kill failed: ${error?.message || error}`);
  }
}

/**
 * 값이 Promise처럼 then을 제공하는지 확인한다.
 * @param {unknown} value - 검사할 값
 * @returns {boolean} Promise 유사 객체 여부
 */
function isPromiseLike(value) {
  return Boolean(value) && typeof value.then === "function";
}

/**
 * 브라우저에서 갱신된 쿠키를 jar 파일에 저장한다.
 * @param {object} page - Puppeteer page 객체
 * @param {object} config - 애플리케이션 설정
 * @param {object} jar - 세션 쿠키를 보관하는 tough-cookie 저장소
 * @returns {Promise<void>} 쿠키 저장 완료
 */
async function persistPageCookies(page, config, jar) {
  await persistPageCookiesToJar(page, config, jar);
  saveJar(config.jarPath, jar);
}

/**
 * Cloudflare challenge 화면이 지나갈 때까지 기다린다.
 * @param {object} page - Puppeteer page 객체
 * @returns {Promise<void>} challenge 통과 확인 완료
 * @throws {Error} 제한 시간 안에 challenge가 해제되지 않을 때 발생
 */
async function waitForChallengeClear(page) {
  try {
    await page.waitForFunction(() => !document.title.toLowerCase().includes("just a moment"), { timeout: 45000 });
  } catch {
    throw new Error(
      "브라우저 세션이 Cloudflare challenge를 통과하지 못했습니다. 열린 Chrome 창에서 Claude가 정상 화면까지 로드되는지 확인하세요."
    );
  }
}
