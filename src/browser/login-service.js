import { redactUrl } from "../shared/mask.js";
import { hasGmailAuth } from "../gmail/gmail-client.js";
import { setTimeout as delay } from "node:timers/promises";
import { connectRealBrowser } from "./real-browser.js";
import { loadJar, saveJar } from "../state/cookie-jar.js";
import { toSetCookieLine } from "./cookie-sync.js";
import { createClaudeMailReader } from "../gmail/latest-claude-mail.js";
import { isCurrentLoginMail, waitForLoginMail } from "../gmail/login-mail.js";
import { saveLatestClaudeCode } from "../state/latest-claude-code.js";
import { resolveBrowserMode } from "./session-manager.js";
import { requestMagicLinkWithCycleTls, openVerificationLinkWithCycleTls } from "../auth/magic-link.js";
const LOGIN_COOKIE_NAMES = ["sessionKey", "routingHint", "lastActiveOrg"];

/**
 * 로그인용 Chrome에서 Claude 세션 쿠키를 수집한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object[]>} 수집된 브라우저 쿠키 목록
 */
export async function collectBrowserCookies(config) {
  const cycleTlsLogin = await collectCookiesWithCycleTlsLogin(config);
  if (cycleTlsLogin?.cookies?.length) {
    console.log("[login] CycleTLS로 확보한 로그인 쿠키를 사용합니다.");
    return cycleTlsLogin.cookies;
  }
  const pendingCycleTlsMail = cycleTlsLogin?.mail || null;
  const fallbackReason = cycleTlsLogin?.fallbackReason || "cycletls_not_attempted";
  const primaryMode = resolveBrowserMode(config, "login", "background");
  const modes = primaryMode === "background" ? ["background", "interactive"] : ["interactive"];

  let lastError = null;
  for (const mode of modes) {
    try {
      return await collectBrowserCookiesWithChromeMode(config, {
        mode,
        pendingCycleTlsMail,
        fallbackReason
      });
    } catch (error) {
      lastError = error;
      if (mode !== "background") throw error;
      console.log(`[login] 백그라운드 Chrome 로그인이 완료되지 않았습니다: ${error?.message || error}`);
      console.log("[login] 화면을 표시하는 Chrome 모드로 다시 시도합니다.");
    }
  }

  throw lastError || new Error("Chrome 로그인에 실패했습니다.");
}

/**
 * 지정한 Chrome 모드에서 로그인 쿠키 수집 흐름을 실행한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} options - Chrome 실행 옵션
 * @returns {Promise<object[]>} 수집된 쿠키 목록
 */
async function collectBrowserCookiesWithChromeMode(config, { mode, pendingCycleTlsMail, fallbackReason }) {
  const attemptConfig =
    mode === "background"
      ? {
          ...config,
          browserLoginTimeoutMs: Math.min(config.browserLoginTimeoutMs, config.browserLoginBackgroundTimeoutMs || 60000)
        }
      : config;

  console.log(`[login] ${mode} Chrome으로 로그인을 이어갑니다. 사유: ${fallbackReason}`);

  const { browser, page } = await connectRealBrowser(config, {
    userDataDir: config.profilePath,
    mode
  });
  const mailWatch = createClaudeMailWatch(config, browser, page);

  try {
    setupPageNavigationLogging(page, attemptConfig, `login:${mode}`);
    await page.goto(attemptConfig.baseUrl, { waitUntil: "domcontentloaded" });
    await prepareChromeLoginFallback(page, attemptConfig, fallbackReason);
    if (pendingCycleTlsMail) {
      await openVerificationLinkFromMail(attemptConfig, browser, page, pendingCycleTlsMail);
    }
    console.log("로그인용 Chrome 창에서 claude.ai 로그인을 완료하세요.");
    console.log("로그인 쿠키가 감지되면 자동으로 session-cookie-jar.json에 저장합니다.");
    if (mailWatch.enabled) {
      console.log("Gmail API를 사용해 Claude 인증 메일을 함께 감시합니다.");
    }

    return await waitForLoginCookies(page, attemptConfig);
  } finally {
    mailWatch.stop();
    await mailWatch.done.catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * 브라우저에서 수집한 쿠키를 cookie jar 파일에 저장한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object[]} cookies - 저장할 브라우저 쿠키 목록
 * @returns {void} 반환값 없음
 */
export function saveCookiesToJar(config, cookies) {
  const jar = loadJar(config.jarPath);

  for (const cookie of cookies) {
    const line = toSetCookieLine(cookie);
    jar.setCookieSync(line, config.baseUrl, { ignoreError: true });
  }

  saveJar(config.jarPath, jar);
}

/**
 * 로그인 유지에 중요한 쿠키만 요약해서 출력한다.
 * @param {object[]} cookies - 출력할 브라우저 쿠키 목록
 * @returns {void} 반환값 없음
 */
export function printCookieSummary(cookies) {
  console.log("쿠키 저장 완료:");
  for (const cookie of cookies.filter(isImportantCookie)) {
    console.log(`${cookie.name}: ${expiresText(cookie)}`);
  }
}

/**
 * 사용자가 브라우저 로그인을 완료할 때까지 세션 쿠키를 기다린다.
 * @param {object} page - Puppeteer page 객체
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object[]>} 로그인 완료 후 쿠키 목록
 * @throws {Error} 제한 시간 안에 로그인 쿠키를 찾지 못할 때 발생
 */
async function waitForLoginCookies(page, config) {
  const deadline = Date.now() + config.browserLoginTimeoutMs;
  let lastProgressAt = 0;

  while (Date.now() < deadline) {
    const cookies = await page.cookies();
    if (hasLoginCookies(cookies)) return cookies;

    if (Date.now() - lastProgressAt >= 30000) {
      lastProgressAt = Date.now();
      const location = safePageUrl(page);
      console.log(`[login] waiting for browser login... ${summarizeCookiePresence(cookies)} current_url=${location}`);
    }
    await delay(config.browserLoginPollMs);
  }

  throw new Error("로그인 쿠키를 찾지 못했습니다. 제한 시간 안에 브라우저 로그인을 완료해야 합니다.");
}

/**
 * Claude 로그인 완료를 판단하는 핵심 쿠키가 모두 있는지 확인한다.
 * @param {object[]} cookies - 브라우저 쿠키 목록
 * @returns {boolean} 로그인 쿠키 존재 여부
 */
function hasLoginCookies(cookies) {
  const names = new Set(cookies.map(cookie => cookie.name));
  return LOGIN_COOKIE_NAMES.every(name => names.has(name));
}

/**
 * 세션 유지에 직접 영향을 주는 쿠키인지 판단한다.
 * @param {object} cookie - 브라우저 쿠키
 * @returns {boolean} 중요 쿠키 여부
 */
function isImportantCookie(cookie) {
  return ["sessionKey", "sessionKeyLC", "routingHint", "lastActiveOrg", "cf_clearance", "__cf_bm", "_cfuvid"].includes(
    cookie.name
  );
}

/**
 * 쿠키 만료 시각을 한국 시간 기준 표시 문자열로 만든다.
 * @param {object} cookie - 브라우저 쿠키
 * @returns {string} 만료 시각 표시 문자열
 */
function expiresText(cookie) {
  if (!cookie.expires || cookie.expires < 0) return "세션 쿠키 또는 만료 정보 없음";
  return new Date(cookie.expires * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

/**
 * 브라우저를 열기 전에 HTTP 로그인을 시도하고 실패하면 다음 경로에 필요한 정보를 넘긴다.
 * @param {object} config - 계정 및 로그인 방식 설정
 * @returns {Promise<object>} 로그인 쿠키 또는 브라우저 재시도 사유
 */
async function collectCookiesWithCycleTlsLogin(config) {
  if (!config.claudeCycleTlsLogin) {
    console.log("[login] CLAUDE_CYCLETLS_LOGIN이 꺼져 있어 HTTP 로그인을 건너뜁니다.");
    return { fallbackReason: "cycletls_disabled" };
  }
  if (!config.gmailTryCycleTlsVerificationLink) {
    console.log("[login] HTTP 인증 링크 처리가 꺼져 있어 브라우저 로그인을 사용합니다.");
    return { fallbackReason: "cycletls_verification_disabled" };
  }

  const email = config.claudeLoginEmail || config.gmailUserEmail;
  if (!email) {
    console.log("[login] 로그인 이메일이 설정되지 않아 HTTP 로그인을 건너뜁니다.");
    return { fallbackReason: "missing_login_email" };
  }

  if (!hasGmailAuth(config)) {
    console.log("[login] Gmail 인증 정보가 없어 브라우저에서 직접 로그인해야 합니다.");
    return { fallbackReason: "missing_gmail_auth" };
  }

  console.log(`[login] ${maskEmail(email)} 계정으로 HTTP 로그인을 시작합니다.`);

  const sentAt = Date.now();

  // ==================== Magic Link 요청 ====================
  const sent = await requestMagicLinkWithCycleTls(config, {
    email,
    source: "claude"
  });

  if (!sent.ok) {
    console.log(`[login] 인증 메일 요청 실패: ${sent.reason || "unknown"}`);
    return { fallbackReason: sent.reason || "magic_link_request_failed" };
  }

  console.log(`[login] 인증 메일을 요청했습니다.`);

  // ==================== 메일 대기 ====================
  const mail = await waitForCycleTlsLoginMail(config, sentAt);
  if (!mail) {
    console.log("[login] 제한 시간 안에 Claude 인증 메일을 받지 못했습니다.");
    return { fallbackReason: "login_mail_timeout" };
  }

  const link = mail.verificationLinks?.[0]?.url;
  if (!link) {
    console.log("[login] 메일에 인증 링크가 없어 Chrome으로 로그인을 이어갑니다.");
    return { mail, fallbackReason: "verification_link_missing" };
  }

  // ==================== Verification Link 처리 ====================
  const opened = await openVerificationLinkWithCycleTls(config, email, link);
  if (!opened.ok) {
    return {
      mail: { ...mail, magicLinkCode: opened.code || null },
      fallbackReason: opened.reason || "verification_link_failed"
    };
  }

  // ==================== 최종 쿠키 확인 ====================
  const cookies = await browserCookiesFromJar(config);
  if (!hasLoginCookies(cookies)) {
    console.log(`[login] HTTP 로그인 후 필수 쿠키가 부족합니다. 쿠키 상태=${summarizeCookiePresence(cookies)}.`);
    return { mail, fallbackReason: "login_cookies_missing_after_cycletls" };
  }

  console.log(`[login] HTTP 로그인에 성공했습니다.`);
  console.log(`[login] 쿠키 상태=${summarizeCookiePresence(cookies)}`);

  return { cookies };
}

/**
 * CycleTLS 로그인 요청 이후 도착한 Claude 메일만 기다린다.
 * @param {object} config - 애플리케이션 설정
 * @param {number} sentAt - 요청을 보낸 시각
 * @returns {Promise<object|null>} 발견된 Claude 메일
 */
export async function waitForCycleTlsLoginMail(config, sentAt) {
  console.log("[gmail] 이번 로그인 요청의 인증 메일을 기다립니다. 최대 대기 시간은 3분입니다.");
  const mail = await waitForLoginMail(config, sentAt);
  if (mail) printClaudeMail(mail);
  else console.log("[gmail] 제한 시간 안에 새 인증 메일이 도착하지 않았습니다.");
  return mail;
}

/**
 * 저장된 jar 쿠키를 브라우저 주입 형식으로 변환한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object[]>} 브라우저 쿠키 목록
 */
async function browserCookiesFromJar(config) {
  const jar = loadJar(config.jarPath);
  const cookies = await jar.getCookies(config.baseUrl);
  const hostname = new URL(config.baseUrl).hostname;

  return cookies.map(cookie => ({
    name: cookie.key,
    value: cookie.value,
    domain: cookie.domain || hostname,
    path: cookie.path || "/",
    expires: cookie.expires instanceof Date ? Math.floor(cookie.expires.getTime() / 1000) : -1,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite
  }));
}

/**
 * 로그인 로그에 이메일 전체가 남지 않도록 가린다.
 * @param {string} email - 마스킹할 이메일
 * @returns {string} 마스킹된 이메일
 */
function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return String(email);
  if (local.length <= 2) return `${local[0] || "*"}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * 로그인 중 도착하는 Claude 인증 메일을 감시한다.
 * @param {object} config - 애플리케이션 설정
 * @param {AbortSignal} signal - 감시 중단 신호
 * @param {object} browser - 브라우저 인스턴스
 * @param {object} loginPage - 로그인 페이지
 * @returns {Promise<void>} 감시 완료 결과
 */
async function watchClaudeMail(config, signal, browser, loginPage) {
  let lastMessageId = null;
  const watchStartedAt = Date.now();
  let skippedExistingMail = false;
  const readMail = createClaudeMailReader(config);

  while (!signal.aborted) {
    try {
      const mail = await readMail({
        allowMissing: true,
        query: config.gmailClaudeQuery,
        maxResults: config.gmailClaudeMaxResults,
        signal
      });

      if (mail && mail.messageId && mail.messageId !== lastMessageId) {
        lastMessageId = mail.messageId;
        if (!isCurrentLoginMail(mail, watchStartedAt)) {
          if (!skippedExistingMail) {
            console.log("[gmail] 이전 메일이나 인증 조건에 맞지 않는 메일을 제외하고 새 메일을 기다립니다.");
            skippedExistingMail = true;
          }
          continue;
        }

        if (signal.aborted) return;
        printClaudeMail(mail);
        await openVerificationLinkFromMail(config, browser, loginPage, mail);
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = String(error?.message || error);
      if (message.includes("Gmail API를 사용하려면")) {
        console.log(message);
        return;
      }

      console.log(`[gmail] ${message}`);
    }

    try {
      await delay(Math.max(1000, config.gmailPollMs || 10000), undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
}

/**
 * Claude 보안 링크를 로그인 Chrome에서 처리한다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} browser - Puppeteer browser 객체
 * @param {object} loginPage - 로그인에 사용 중인 Puppeteer page 객체
 * @param {object} mail - Claude 메일 요약
 * @returns {Promise<void>} 링크 처리 완료
 */
async function openVerificationLinkFromMail(config, browser, loginPage, mail) {
  if (!config.gmailOpenVerificationLink) return;

  const link = mail.verificationLinks?.[0];
  if (mail.verificationCode) {
    persistLatestClaudeCode(config, mail.verificationCode, {
      source: "gmail-mail-body",
      email: config.claudeLoginEmail || config.gmailUserEmail || "",
      verificationLink: link?.url || "",
      messageId: mail.messageId || ""
    });
  }
  if (!link?.url) return;

  if (mail.magicLinkCode) {
    persistLatestClaudeCode(config, mail.magicLinkCode, {
      source: "gmail-cycle-tls",
      email: config.claudeLoginEmail || config.gmailUserEmail || "",
      verificationLink: link.url
    });
    const filled = await fillVerificationCode(loginPage, mail.magicLinkCode, config);
    if (filled && (await waitForLoginPageSuccess(loginPage, config))) return;
  }

  if (!mail.magicLinkCode && config.gmailTryCycleTlsVerificationLink) {
    const result = await openVerificationLinkWithCycleTls(
      config,
      config.claudeLoginEmail || config.gmailUserEmail,
      link.url
    );
    if (result.ok) return;
    if (result.code) {
      persistLatestClaudeCode(config, result.code, {
        source: "cycle-tls-open-verification-link",
        email: config.claudeLoginEmail || config.gmailUserEmail || "",
        verificationLink: link.url
      });
      const filled = await fillVerificationCode(loginPage, result.code, config);
      if (filled && (await waitForLoginPageSuccess(loginPage, config))) return;
    }
  }

  try {
    console.log(`[gmail] Chrome에서 새 인증 링크를 엽니다.`);
    const page = typeof browser.newPage === "function" ? await browser.newPage() : loginPage;
    setupPageNavigationLogging(page, config, page === loginPage ? "login" : "mail-link");
    await page.goto(link.url, {
      waitUntil: "domcontentloaded",
      timeout: config.gmailVerificationLinkTimeoutMs || 60000
    });
    await delay(2000);

    const result = await extractVerificationPageResult(page);
    console.log(`[gmail] 이동한 주소: ${redactUrl(result.url)}`);
    if (result.title) console.log(`[gmail] 페이지 제목: ${result.title}`);

    if (isClaudeAppUrl(result.url, config)) {
      console.log("[gmail] Claude 화면으로 이동했습니다. 로그인 쿠키를 기다립니다.");
      if (page !== loginPage) {
        await loginPage
          .goto(config.baseUrl, {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.gmailVerificationLinkTimeoutMs || 60000, 15000)
          })
          .catch(() => {});
      }
      return;
    }

    if (result.codes.length) {
      console.log(`[gmail] 인증 코드 후보 ${result.codes.length}개를 확보했습니다.`);
      persistLatestClaudeCode(config, result.codes[0], {
        source: "verification-page",
        email: config.claudeLoginEmail || config.gmailUserEmail || "",
        verificationLink: link.url,
        pageUrl: result.url
      });
      await fillVerificationCode(loginPage, result.codes[0], config);
      if (page !== loginPage) await fillVerificationCode(page, result.codes[0], config);
    } else {
      console.log("[gmail] 페이지에서 인증 코드를 찾지 못했습니다.");
    }
  } catch (error) {
    console.log(`[gmail] 인증 링크를 열지 못했습니다: ${error?.message || error}`);
  }
}

/**
 * 인증 페이지가 세션 완료 상태로 전환됐는지 확인한다.
 * @param {object} page - 브라우저 페이지
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<boolean>} 로그인 성공 여부
 */
async function waitForLoginPageSuccess(page, config) {
  await delay(3000);

  const cookies = await page.cookies().catch(() => []);
  if (hasLoginCookies(cookies)) {
    console.log("[gmail] 인증 코드 제출 후 로그인 쿠키를 확인했습니다.");
    return true;
  }

  const result = await extractVerificationPageResult(page).catch(() => null);
  if (result && isClaudeAppUrl(result.url, config)) {
    console.log("[gmail] 인증 코드 제출 후 Claude 화면에 도착했습니다. 쿠키를 기다립니다.");
    return true;
  }

  return false;
}

/**
 * 서버가 문자열로 반환한 응답을 안전하게 JSON으로 변환한다.
 * @param {string} value - JSON 후보 문자열
 * @returns {object|null} 파싱된 JSON 객체
 */
function parseJsonResponse(value) {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 자동 요청 실패 후 사용자가 이어서 로그인할 수 있게 브라우저 상태를 준비한다.
 * @param {object} page - 브라우저 페이지
 * @param {object} config - 애플리케이션 설정
 * @param {string} fallbackReason - fallback으로 전환한 사유
 * @returns {Promise<void>} 반환값 없음
 */
async function prepareChromeLoginFallback(page, config, fallbackReason) {
  const email = config.claudeLoginEmail || config.gmailUserEmail;
  console.log(`[login] Chrome 로그인 화면을 준비했습니다. 사유: ${fallbackReason}`);

  if (!email) return;
  if (await requestMagicLinkFromBrowserPage(page, config, email)) return;
  if (!shouldPrimeEmailInput(fallbackReason)) return;

  const primed = await fillEmailLoginForm(page, email);
  if (primed) {
    console.log(`[login] Chrome 로그인 입력칸에 ${maskEmail(email)} 주소를 채웠습니다.`);
  } else {
    console.log("[login] 이메일 입력칸을 찾지 못했습니다. Chrome에서 직접 로그인하세요.");
  }
}

/**
 * 브라우저 컨텍스트의 쿠키와 헤더로 magic link 요청을 보낸다.
 * @param {object} page - 브라우저 페이지
 * @param {object} config - 애플리케이션 설정
 * @param {string} email - 로그인 이메일
 * @returns {Promise<object>} 요청 결과
 */
async function requestMagicLinkFromBrowserPage(page, config, email) {
  if (!config.claudeBrowserMagicLinkRequest) return false;

  const timeoutMs = Math.max(5000, config.claudeBrowserMagicLinkRequestTimeoutMs || 60000);
  const loginUrl = `${config.baseUrl}/login`;

  try {
    const cookies = await page.cookies().catch(() => []);
    if (hasLoginCookies(cookies)) return true;

    if (!safePageUrl(page).startsWith(loginUrl)) {
      await page
        .goto(loginUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(timeoutMs, 60000)
        })
        .catch(() => {});
    }

    await waitForBrowserChallengeClear(page, timeoutMs);

    const result = await page.evaluate(
      async ({ email, locale, timeoutMs }) => {
        /**
         * 브라우저 요청이 제한 시간을 넘기면 중단하고 완료 후에는 타이머를 해제한다.
         * @param {Function} fn - 중단 신호를 받아 실행할 요청 함수
         * @returns {Promise<unknown>} 요청 함수의 반환값
         */
        const withTimeout = async fn => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await fn(controller.signal);
          } finally {
            clearTimeout(timer);
          }
        };

        /**
         * 오류 메시지가 너무 길어지지 않도록 응답 본문을 300자로 줄인다.
         * @param {unknown} text - 응답 본문
         * @returns {string} 길이를 제한한 본문
         */
        const shortBody = text => String(text || "").slice(0, 300);
        /**
         * 일반 API 오류와 브라우저 확인 화면을 구분한다.
         * @param {Response} response - 브라우저 fetch 응답
         * @param {string} text - 응답 본문
         * @returns {boolean} 브라우저 확인이 필요한 응답인지 여부
         */
        const isCloudflareBlock = (response, text) =>
          response.status === 403 ||
          response.headers.get("cf-mitigated") === "challenge" ||
          /just a moment|verify you are human|cf-mitigated/i.test(text);

        return withTimeout(async signal => {
          const methodsResponse = await fetch(
            `/api/auth/login_methods?email=${encodeURIComponent(email)}&source=claude-ai`,
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
          if (isCloudflareBlock(methodsResponse, methodsText)) {
            return {
              ok: false,
              step: "login_methods",
              status: methodsResponse.status,
              cfBlocked: true,
              body: shortBody(methodsText)
            };
          }

          let methodsJson = null;
          try {
            methodsJson = JSON.parse(methodsText);
          } catch {}

          const methods = Array.isArray(methodsJson?.methods) ? methodsJson.methods : [];
          if (!methodsResponse.ok || (methods.length && !methods.includes("magic_link"))) {
            return {
              ok: false,
              step: "login_methods",
              status: methodsResponse.status,
              methods,
              body: shortBody(methodsText)
            };
          }

          const magicLinkResponse = await fetch("/api/auth/send_magic_link", {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "*/*",
              "Content-Type": "application/json",
              "anthropic-client-platform": "web_claude_ai"
            },
            body: JSON.stringify({
              utc_offset: new Date().getTimezoneOffset(),
              email_address: email,
              login_intent: null,
              locale,
              return_to: null,
              source: "claude"
            }),
            signal
          });
          const magicLinkText = await magicLinkResponse.text();
          return {
            ok: magicLinkResponse.ok,
            step: "send_magic_link",
            status: magicLinkResponse.status,
            methods,
            body: shortBody(magicLinkText)
          };
        });
      },
      {
        email,
        locale: config.locale || "ko-KR",
        timeoutMs: Math.min(timeoutMs, 30000)
      }
    );

    const browserCookies = await page.cookies(config.baseUrl).catch(() => []);
    const pendingLogin = browserCookies.some(cookie => cookie.name === "pendingLogin");

    if (result?.ok) {
      console.log(
        `[login] browser-session magic link requested for ${maskEmail(email)} (${result.status}); pendingLogin=${pendingLogin ? "yes" : "no"}.`
      );
      return true;
    }

    if (result?.cfBlocked) {
      console.log("[login] 브라우저 확인 단계가 필요합니다. Chrome에 표시된 안내를 완료하세요.");
    } else {
      console.log(
        `[login] browser-session magic link request failed at ${result?.step || "unknown"} (${result?.status || "no-status"}).`
      );
    }
    return false;
  } catch (error) {
    console.log(`[login] 브라우저에서 인증 메일을 요청하지 못했습니다: ${error?.message || error}`);
    return false;
  }
}

/**
 * Cloudflare challenge 화면이 사라질 때까지 기다린다.
 * @param {object} page - 브라우저 페이지
 * @param {number} timeoutMs - 제한 시간(ms)
 * @returns {Promise<boolean>} challenge 해제 여부
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
    return true;
  } catch {
    console.log("[login] 브라우저 확인 화면의 종료 여부가 불명확해 현재 세션으로 요청을 한 번 시도합니다.");
    return false;
  }
}

/**
 * fallback 사유에 따라 이메일 입력을 선점해도 되는지 결정한다.
 * @param {string} fallbackReason - fallback으로 전환한 사유
 * @returns {boolean} 이메일 입력 선점 여부
 */
function shouldPrimeEmailInput(fallbackReason) {
  return [
    "magic_link_request_http_500",
    "magic_link_request_exception",
    "magic_link_request_failed",
    "missing_gmail_auth",
    "missing_login_email",
    "login_mail_timeout",
    "cycletls_disabled",
    "cycletls_verification_disabled"
  ].includes(fallbackReason);
}

/**
 * Claude 로그인 폼에서 이메일 입력칸을 찾아 채운다.
 * @param {object} page - 브라우저 페이지
 * @param {string} email - 로그인 이메일
 * @returns {Promise<boolean>} 입력 성공 여부
 */
async function fillEmailLoginForm(page, email) {
  try {
    const selector = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll("input")].filter(input => {
        const style = getComputedStyle(input);
        const rect = input.getBoundingClientRect();
        const metadata = [
          input.type,
          input.name,
          input.id,
          input.autocomplete,
          input.placeholder,
          input.getAttribute("aria-label")
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0 &&
          input.type !== "hidden" &&
          (input.type === "email" ||
            input.autocomplete === "email" ||
            metadata.includes("email") ||
            metadata.includes("e-mail") ||
            metadata.includes("mail"))
        );
      });

      const input = candidates[0];
      if (!input) return null;
      if (!input.id) input.id = `auto-email-input-${Date.now()}`;
      return `#${CSS.escape(input.id)}`;
    });

    if (!selector) return false;

    await page.focus(selector);
    await page.evaluate(currentSelector => {
      const input = document.querySelector(currentSelector);
      if (input) input.value = "";
    }, selector);
    await page.type(selector, email, { delay: 20 });
    await clickEmailSubmit(page);
    return true;
  } catch {
    return false;
  }
}

/**
 * 로그인 폼 제출 버튼을 찾아 클릭한다.
 * @param {object} page - 브라우저 페이지
 * @returns {Promise<boolean>} 클릭 성공 여부
 */
async function clickEmailSubmit(page) {
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button, input[type='submit']")].filter(button => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      const text = [button.innerText, button.value, button.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        !button.disabled &&
        (text.includes("continue") ||
          text.includes("email") ||
          text.includes("sign in") ||
          text.includes("login") ||
          text.includes("continue with email") ||
          text.includes("계속") ||
          text.includes("로그인"))
      );
    });

    const button = buttons[0];
    if (button) button.click();
  });
}

/**
 * 로그인 핵심 쿠키의 존재 여부를 짧게 요약한다.
 * @param {object[]} cookies - 브라우저 쿠키 목록
 * @returns {string} 쿠키 존재 요약
 */
function summarizeCookiePresence(cookies) {
  const names = new Set(cookies.map(cookie => cookie.name));
  return LOGIN_COOKIE_NAMES.map(name => `${name}=${names.has(name) ? "yes" : "no"}`).join(", ");
}

/**
 * 최근 인증 코드를 장애 복구용 파일에 저장한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string} code - 저장할 인증 코드
 * @param {object} details - 코드 출처 정보
 * @returns {void} 반환값 없음
 */
function persistLatestClaudeCode(config, code, details = {}) {
  if (!code) return;

  const payload = {
    code,
    savedAt: new Date().toISOString(),
    ...details
  };
  saveLatestClaudeCode(config.latestClaudeCodePath, payload);
  console.log(`[gmail] 최신 인증 코드를 저장했습니다: ${config.latestClaudeCodePath}`);
}

/**
 * 로그인 디버깅을 위해 페이지 이동 이벤트를 기록한다.
 * @param {object} page - 브라우저 페이지
 * @param {object} config - 애플리케이션 설정
 * @param {string} label - 로그 라벨
 * @returns {void} 반환값 없음
 */
function setupPageNavigationLogging(page, config, label) {
  if (!page || page.__claudeNavigationLoggingInstalled) return;
  page.__claudeNavigationLoggingInstalled = true;

  let lastLoggedUrl = "";
  /**
   * 같은 주소의 반복 이동을 제외하고 인증 화면의 진행 상태를 출력한다.
   * @param {string} event - 이동이나 페이지 열림을 알리는 이벤트 이름
   * @returns {void} 반환값 없음
   */
  const logPageState = event => {
    const url = safePageUrl(page);
    if (!url || url === "(unknown)" || (event === "framenavigated" && url === lastLoggedUrl)) return;
    lastLoggedUrl = url;

    const summary = summarizeNavigationTarget(url, config);
    console.log(`[login] [${label}] ${event}: ${redactUrl(url)}${summary ? ` (${summary})` : ""}`);
  };

  page.on("domcontentloaded", () => logPageState("domcontentloaded"));
  page.on("load", () => logPageState("load"));
  page.on("framenavigated", frame => {
    if (typeof frame?.parentFrame === "function" && frame.parentFrame()) return;
    logPageState("framenavigated");
  });
  page.on("request", request => {
    try {
      if (request.isNavigationRequest?.() && request.frame?.() === page.mainFrame()) {
        const url = request.url();
        const summary = summarizeNavigationTarget(url, config);
        console.log(`[login] [${label}] request: ${request.method()} ${url}${summary ? ` (${summary})` : ""}`);
      }
    } catch {}
  });
}

/**
 * 인증 화면의 종류를 구분해 이동 로그에 붙일 짧은 설명을 만든다.
 * @param {string} value - 원본 URL
 * @param {object} config - 애플리케이션 설정
 * @returns {string} 화면 종류와 외부 도메인에 대한 요약
 */
function summarizeNavigationTarget(value, config) {
  try {
    const url = new URL(value);
    const baseOrigin = new URL(config.baseUrl).origin;
    const parts = [];

    if (url.origin !== baseOrigin) {
      parts.push(`cross-origin:${url.host}`);
    }

    if (url.pathname === "/login") parts.push("login");
    if (url.pathname === "/magic-link") parts.push("magic-link");
    if (url.pathname === "/restricted") parts.push("restricted");
    if (url.pathname === "/logout") parts.push("logout");
    if (url.pathname.startsWith("/cdn-cgi/challenge-platform")) parts.push("cloudflare-challenge");
    if (url.pathname.includes("arkose")) parts.push("arkose");
    if (url.pathname.startsWith("/api/")) parts.push("api");
    if (url.pathname.startsWith("/edge-api/bootstrap")) parts.push("bootstrap");
    if (isClaudeAppUrl(value, config)) parts.push("claude-app");

    const hash = url.hash.replace(/^#/, "");
    if (url.pathname === "/magic-link" && hash.includes(":")) parts.push("magic-link-token");
    return [...new Set(parts)].join(", ");
  } catch {
    return "";
  }
}

/**
 * 자동 인증 흐름에서 확인된 코드를 브라우저 입력칸에 채운다.
 * @param {object} page - 브라우저 페이지
 * @param {string} code - 인증 코드
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<boolean>} 입력 성공 여부
 */
async function fillVerificationCode(page, code, config) {
  if (!config.gmailAutoFillVerificationCode || !code) return false;

  try {
    const selector = await findVerificationInputSelector(page);
    if (!selector) {
      console.log("[gmail] 인증 코드 입력칸이 없어 자동 입력을 건너뜁니다.");
      return false;
    }

    await page.focus(selector);
    await page.evaluate(currentSelector => {
      const input = document.querySelector(currentSelector);
      if (input) input.value = "";
    }, selector);
    await page.type(selector, code, { delay: 30 });
    console.log(`[gmail] 인증 코드를 자동 입력했습니다: ${selector}`);
    await clickVerificationSubmit(page);
    return true;
  } catch (error) {
    console.log(`[gmail] 자동 입력 실패: ${error?.message || error}`);
    return false;
  }
}

/**
 * 고정 selector가 없어 입력 속성 기반으로 인증번호 입력칸을 찾는다.
 * @param {object} page - Puppeteer page 객체
 * @returns {Promise<string|null>} 입력칸 selector 또는 null
 */
async function findVerificationInputSelector(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("input")].filter(input => {
      const style = getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      const metadata = [
        input.type,
        input.name,
        input.id,
        input.autocomplete,
        input.inputMode,
        input.placeholder,
        input.getAttribute("aria-label")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        input.type !== "hidden" &&
        input.type !== "email" &&
        (metadata.includes("code") ||
          metadata.includes("otp") ||
          metadata.includes("token") ||
          metadata.includes("verification") ||
          metadata.includes("인증") ||
          metadata.includes("코드") ||
          input.autocomplete === "one-time-code" ||
          input.inputMode === "numeric" ||
          input.type === "tel")
      );
    });

    const input =
      candidates[0] ||
      [...document.querySelectorAll("input")].find(item => {
        const style = getComputedStyle(item);
        const rect = item.getBoundingClientRect();
        const metadata = [
          item.type,
          item.name,
          item.id,
          item.autocomplete,
          item.inputMode,
          item.placeholder,
          item.getAttribute("aria-label")
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0 &&
          item.type !== "hidden" &&
          item.type !== "email" &&
          item.autocomplete !== "email" &&
          !metadata.includes("email") &&
          !metadata.includes("e-mail") &&
          !metadata.includes("mail")
        );
      });
    if (!input) return null;

    if (!input.id) input.id = `auto-code-input-${Date.now()}`;
    return `#${CSS.escape(input.id)}`;
  });
}

/**
 * 페이지 URL 조회 실패가 디버그 로그를 중단하지 않도록 감싼다.
 * @param {object} page - 브라우저 페이지
 * @returns {string} 현재 URL 또는 fallback 값
 */
function safePageUrl(page) {
  try {
    return typeof page?.url === "function" ? page.url() : "(unknown)";
  } catch {
    return "(unknown)";
  }
}

/**
 * 인증 화면 문구가 locale마다 달라질 수 있어 여러 버튼 문구를 허용한다.
 * @param {object} page - Puppeteer page 객체
 * @returns {Promise<boolean>} 클릭 여부
 */
async function clickVerificationSubmit(page) {
  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button, input[type='submit']")].filter(button => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      const text = [button.innerText, button.value, button.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        !button.disabled &&
        (text.includes("continue") ||
          text.includes("verify") ||
          text.includes("submit") ||
          text.includes("확인") ||
          text.includes("계속") ||
          text.includes("로그인"))
      );
    });

    const button = buttons[0];
    if (!button) return false;
    button.click();
    return true;
  });

  if (clicked) console.log("[gmail] 인증 확인 버튼을 눌렀습니다.");
  else console.log("[gmail] 자동 입력 후 인증 확인 버튼을 찾지 못했습니다.");
  return clicked;
}

/**
 * 인증 완료 후 이동한 주소가 Claude 앱 화면인지 확인한다.
 * @param {string} url - 검사할 URL
 * @param {object} config - 애플리케이션 설정
 * @returns {boolean} Claude 앱 URL 여부
 */
function isClaudeAppUrl(url, config) {
  try {
    const current = new URL(url);
    const base = new URL(config.baseUrl);
    return (
      current.hostname === base.hostname &&
      ["/new", "/chat"].some(path => current.pathname === path || current.pathname.startsWith(`${path}/`))
    );
  } catch {
    return false;
  }
}

/**
 * 브라우저 렌더링 이후에만 보이는 인증번호 후보를 추출한다.
 * @param {object} page - Puppeteer page 객체
 * @returns {Promise<object>} 페이지 정보와 인증번호 후보
 */
async function extractVerificationPageResult(page) {
  const snapshot = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body?.innerText || ""
  }));

  return {
    url: snapshot.url,
    title: snapshot.title,
    codes: extractNumericCodes(snapshot.text)
  };
}

/**
 * Claude 인증번호로 쓰일 가능성이 있는 짧은 숫자만 추린다.
 * @param {string} text - 검사할 텍스트
 * @returns {string[]} 중복 제거된 숫자 코드 후보
 */
function extractNumericCodes(text) {
  const matches = String(text || "").match(/\b\d{5,8}\b/g) || [];
  return [...new Set(matches)];
}

/**
 * Claude 인증 메일의 핵심 내용을 출력한다.
 * @param {object} mail - Claude 메일 요약
 * @returns {void} 반환값 없음
 */
function printClaudeMail(mail) {
  console.log("\n[gmail] Claude 메일 발견");
  if (mail.subject) console.log(`[gmail] 제목: ${mail.subject}`);
  if (mail.from) console.log(`[gmail] 발신자: ${mail.from}`);
  if (mail.date) console.log(`[gmail] 수신 시각: ${mail.date}`);
  if (mail.verificationCode) console.log("[gmail] 인증 코드를 확보했습니다.");
  console.log(`[gmail] 인증 링크 ${mail.verificationLinks?.length || 0}개를 확보했습니다.`);
}

/**
 * 메일 감시를 중단하기 위한 제어기를 만든다.
 * @param {object} config - 애플리케이션 설정
 * @param {object} browser - Puppeteer browser 객체
 * @param {object} loginPage - 로그인에 사용 중인 Puppeteer page 객체
 * @returns {{ enabled: boolean, done: Promise<void>, stop: () => void }} 중단 제어 객체
 */
function createClaudeMailWatch(config, browser, loginPage) {
  const controller = new AbortController();
  const enabled = hasGmailAuth(config);
  const done = enabled ? watchClaudeMail(config, controller.signal, browser, loginPage) : Promise.resolve();

  return {
    enabled,
    done,
    /**
     * 로그인 완료나 브라우저 종료 시 메일 조회 사이의 대기를 취소한다.
     * @returns {void} 반환값 없음
     */
    stop() {
      controller.abort();
    }
  };
}
