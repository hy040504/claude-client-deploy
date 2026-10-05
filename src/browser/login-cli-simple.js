import { setTimeout as delay } from "node:timers/promises";
import { createAppConfig } from "../config/app-config.js";
import { connectRealBrowser } from "./real-browser.js";
import { loadJar } from "../state/cookie-jar.js";
import { applyJarCookies } from "./cookie-sync.js";
import { requestMagicLinkWithCycleTls } from "../auth/magic-link.js";
import { waitForCycleTlsLoginMail, printCookieSummary, saveCookiesToJar } from "./login-service.js";
import { shutdownCycleTls } from "../http/cycletls-client.js";

const REQUIRED_LOGIN_COOKIES = ["sessionKey", "routingHint", "lastActiveOrg"];

/**
 * 브라우저 기반의 간소화 로그인 흐름을 실행한다
 * @param {object} overrides - 실행 시 덮어쓸 설정 값
 * @returns {Promise<object[]>} 최종 로그인 쿠키 목록
 * @throws {Error} 로그인 이메일이나 최종 로그인 쿠키를 확보하지 못하면 발생
 */
export async function runSimpleBrowserLoginCli(overrides = {}) {
  const config = { ...createAppConfig(overrides), ...overrides };
  const email = config.claudeLoginEmail || config.gmailUserEmail;

  if (!email) {
    throw new Error("CLAUDE_LOGIN_EMAIL 또는 GMAIL_USER_EMAIL이 설정되지 않았습니다.");
  }

  const { browser, page } = await connectRealBrowser(config, {
    userDataDir: config.profilePath,
    mode: config.browserLoginMode || "background"
  });

  try {
    const jar = loadJar(config.jarPath);
    await applyJarCookies(page, config.baseUrl, jar);

    const link = await requestMagicLinkWithSimplePath(page, config, email);
    console.log(`[login] Chrome에서 이번 요청의 인증 링크를 엽니다.`);

    await page.goto(link, {
      waitUntil: "domcontentloaded",
      timeout: config.gmailVerificationLinkTimeoutMs || 60000
    });

    const cookies = await waitForLoginCookies(page, config);
    saveCookiesToJar(config, cookies);
    printCookieSummary(cookies);
    return cookies;
  } finally {
    await browser.close().catch(() => {});
    await shutdownCycleTls();
  }
}

/**
 * 동작이 검증된 최소 단계만 사용해 magic link를 확보한다
 * @param {object} page - Puppeteer 페이지 객체
 * @param {object} config - 애플리케이션 설정
 * @param {string} email - 로그인에 사용할 이메일 주소
 * @returns {Promise<string>} 확인된 magic link URL
 * @throws {Error} 로그인 메일에서 magic link를 찾지 못하면 발생
 */
async function requestMagicLinkWithSimplePath(page, config, email) {
  const sentAt = Date.now();

  const cycleTlsResult = await requestMagicLinkWithCycleTls(
    {
      ...config,
      forceMode: "no-arkose",
      arkoseEnabled: false
    },
    {
      email,
      source: "claude"
    }
  );

  if (!cycleTlsResult.ok) {
    console.log(`[login] CycleTLS no-arkose 요청 실패: ${cycleTlsResult.reason || cycleTlsResult.status || "unknown"}`);
    console.log("[login] 브라우저 세션에서 magic link 요청을 다시 시도합니다...");
    await requestMagicLinkFromBrowserPage(page, config, email);
  }

  const mail = await waitForCycleTlsLoginMail(config, sentAt);
  if (!mail?.verificationLinks?.[0]?.url) {
    throw new Error("로그인용 magic link 메일을 찾지 못했습니다.");
  }

  return mail.verificationLinks[0].url;
}

/**
 * CycleTLS 요청이 막힐 때 브라우저 세션 안에서 magic link 요청을 재시도한다
 * @param {object} page - Puppeteer 페이지 객체
 * @param {object} config - 애플리케이션 설정
 * @param {string} email - 로그인에 사용할 이메일 주소
 * @returns {Promise<void>} 요청 완료
 * @throws {Error} 브라우저 기반 요청이 실패하면 발생
 */
async function requestMagicLinkFromBrowserPage(page, config, email) {
  const timeoutMs = Math.max(5000, config.claudeBrowserMagicLinkRequestTimeoutMs || 60000);
  const loginUrl = `${config.baseUrl}/login`;

  if (!(await safePageUrl(page)).startsWith(loginUrl)) {
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeoutMs, 60000)
    });
  }

  await waitForBrowserChallengeClear(page, timeoutMs);

  const result = await page.evaluate(
    async ({ emailAddress, locale, maxWaitMs }) => {
      /**
       * 브라우저 내부 요청이 멈춰도 정해진 시간이 지나면 취소 신호를 보낸다.
       * @param {Function} fn - 중단 신호를 받아 실행할 요청 함수
       * @returns {Promise<unknown>} 요청 함수의 반환값
       */
      const withTimeout = async fn => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), maxWaitMs);
        try {
          return await fn(controller.signal);
        } finally {
          clearTimeout(timer);
        }
      };

      return withTimeout(async signal => {
        const methodsResponse = await fetch(
          `/api/auth/login_methods?email=${encodeURIComponent(emailAddress)}&source=claude-ai`,
          {
            credentials: "include",
            headers: {
              Accept: "*/*",
              "Content-Type": "application/json",
              "anthropic-client-platform": "web_claude_ai"
            },
            signal
          }
        );

        const methodsText = await methodsResponse.text();
        if (!methodsResponse.ok) {
          throw new Error(`login_methods 실패: ${methodsResponse.status} ${methodsText.slice(0, 200)}`);
        }

        const sendResponse = await fetch("/api/auth/send_magic_link", {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "*/*",
            "Content-Type": "application/json",
            "anthropic-client-platform": "web_claude_ai"
          },
          body: JSON.stringify({
            utc_offset: new Date().getTimezoneOffset(),
            email_address: emailAddress,
            login_intent: null,
            locale,
            return_to: null,
            source: "claude"
          }),
          signal
        });

        const sendText = await sendResponse.text();
        return {
          ok: sendResponse.ok,
          status: sendResponse.status,
          body: sendText.slice(0, 200)
        };
      });
    },
    {
      emailAddress: email,
      locale: config.locale || "ko-KR",
      maxWaitMs: Math.min(timeoutMs, 30000)
    }
  );

  if (!result?.ok) {
    throw new Error(`브라우저 magic link 요청 실패: ${result?.status || "unknown"} ${result?.body || ""}`);
  }
}

/**
 * Cloudflare challenge 화면이 사라질 때까지 대기한다
 * @param {object} page - Puppeteer 페이지 객체
 * @param {number} timeoutMs - 최대 대기 시간
 * @returns {Promise<void>} 대기 완료
 */
async function waitForBrowserChallengeClear(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const title = document.title || "";
        const text = document.body?.innerText || "";
        return (
          !/just a moment/i.test(title) &&
          !/verify you are human/i.test(text) &&
          !location.pathname.startsWith("/cdn-cgi/")
        );
      },
      { timeout: timeoutMs }
    );
  } catch {
    // challenge가 완전히 사라지지 않아도 이후 브라우저 fetch를 한번 시도해 본다
  }
}

/**
 * 로그인 완료에 필요한 핵심 쿠키가 모두 생길 때까지 polling한다
 * @param {object} page - Puppeteer 페이지 객체
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object[]>} 감지된 로그인 쿠키 목록
 * @throws {Error} 제한 시간 안에 핵심 쿠키를 확보하지 못하면 발생
 */
async function waitForLoginCookies(page, config) {
  const deadline = Date.now() + (config.browserLoginTimeoutMs || 5 * 60 * 1000);
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    const cookies = await page.cookies().catch(() => []);
    if (hasRequiredLoginCookies(cookies)) return cookies;

    if (Date.now() - lastLogAt >= 10000) {
      lastLogAt = Date.now();
      const names = new Set(cookies.map(cookie => cookie.name));
      console.log(
        `[login] 로그인 쿠키를 기다립니다. ${REQUIRED_LOGIN_COOKIES.map(name => `${name}=${names.has(name) ? "yes" : "no"}`).join(", ")}`
      );
    }

    await delay(config.browserLoginPollMs || 1000);
  }

  throw new Error("로그인 쿠키를 찾지 못했습니다. Chrome에서 로그인 상태를 확인하세요.");
}

/**
 * 세션 재사용에 필요한 핵심 로그인 쿠키 존재 여부를 확인한다
 * @param {object[]} cookies - 브라우저에서 읽은 쿠키 목록
 * @returns {boolean} 필수 쿠키 충족 여부
 */
function hasRequiredLoginCookies(cookies) {
  const names = new Set(cookies.map(cookie => cookie.name));
  return REQUIRED_LOGIN_COOKIES.every(name => names.has(name));
}

/**
 * 페이지 객체 접근 중 예외가 나도 안전하게 현재 URL만 읽는다
 * @param {object} page - Puppeteer 페이지 객체
 * @returns {Promise<string>} 현재 페이지 URL 또는 빈 문자열
 */
async function safePageUrl(page) {
  try {
    return typeof page?.url === "function" ? page.url() : "";
  } catch {
    return "";
  }
}
