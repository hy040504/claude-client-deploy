// interactive-login.js
/**
 * Interactive Chrome Only - send_magic_link부터 시작 + 로그인 성공 감지 강화 버전
 * magic-link 접속 후 자동 로그인이 완료되는 상황을 완벽하게 처리합니다.
 */

import { createAppConfig } from "../src/config/app-config.js";
import { findLatestClaudeMail } from "../src/gmail/latest-claude-mail.js";
import { connectRealBrowser } from "../src/browser/real-browser.js";
import { applyJarCookies } from "../src/browser/cookie-sync.js";
import { loadJar } from "../src/state/cookie-jar.js";
import { requestMagicLinkWithCycleTls, verifyMagicLinkWithCycleTls } from "../src/auth/magic-link.js";
import { saveLatestClaudeCode } from "../src/state/latest-claude-code.js";
import { shutdownCycleTls } from "../src/http/cycletls-client.js";
import { setTimeout as delay } from "node:timers/promises";
import chalk from "chalk";

const config = createAppConfig();

const spinnerFrames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

async function runInteractiveLogin() {
  console.log(chalk.cyan.bold("\n=================================================="));
  console.log(chalk.cyan.bold("===          Interactive Chrome 로그인         ==="));
  console.log(chalk.cyan.bold("==================================================\n"));

  const email = config.claudeLoginEmail || config.gmailUserEmail;
  if (!email) {
    console.error(chalk.red("❌ [LOGIN] 에러: CLAUDE_LOGIN_EMAIL 또는 GMAIL_USER_EMAIL이 설정되지 않았습니다."));
    process.exit(1);
  }

  console.log(chalk.cyan(`[LOGIN] 대상 이메일: ${chalk.blue.bold(maskEmail(email))}`));

  try {
    // Step 1: Magic Link 인증메일 요청
    console.log(chalk.cyan("\n[Step 1] Magic Link 인증메일 요청 시작..."));
    const sent = await requestMagicLinkWithCycleTls(config, { email, source: "claude" });
    if (!sent.ok) {
      console.error(chalk.red(`❌ [Step 1] 실패: ${sent.reason}`));
      process.exit(1);
    }
    console.log(chalk.green("[Step 1 완료] ✅ Magic Link 발송 성공"));

    // Step 2: Gmail 메일 대기
    console.log(chalk.cyan("\n[Step 2] Gmail에서 최신 인증 메일 대기 중..."));
    // 메일이 서버에 도착할 시간을 고려하여 잠시 대기
    await delay(5000);
    const mail = await findLatestClaudeMail(config, { allowMissing: false });
    const magicLinkUrl = mail.verificationLinks?.[0]?.url;

    if (!magicLinkUrl) {
      console.error(chalk.red("❌ [Step 2] 에러: magic-link URL을 찾지 못했습니다."));
      process.exit(1);
    }

    console.log(chalk.green(`[gmail] ✅ 새 Claude 로그인 메일 감지!`));
    console.log(chalk.cyan(`[gmail] link: ${chalk.blue(magicLinkUrl)}`));

    // Step 3: Interactive Chrome 실행
    console.log(chalk.cyan("\n[Step 3] [browser] INTERACTIVE Chrome 로그인 모드 실행 중..."));
    const { browser, page } = await connectRealBrowser(config, {
      userDataDir: config.profilePath || ".browser-profile",
      mode: "interactive",
      headless: false
    });

    try {
      const jar = loadJar(config.jarPath);
      await applyJarCookies(page, config.baseUrl, jar);

      console.log(chalk.cyan(`[browser] magic-link URL 접속: ${chalk.blue(magicLinkUrl)}`));
      await page.goto(magicLinkUrl, { waitUntil: "networkidle2", timeout: 90000 });

      // Polling with independent fast spinner
      let success = false;
      let currentPolling = 1;
      let spinnerIndex = 0;

      const updateProgress = () => {
        const frame = spinnerFrames[spinnerIndex];
        process.stdout.write(`\r[browser] 🔄 polling ${currentPolling.toString().padStart(3, '0')}/120 | magic-link 처리 중... ${frame}`);
        spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      };

      const spinnerInterval = setInterval(updateProgress, 100);

      for (currentPolling = 1; currentPolling <= 120; currentPolling++) {
        const isLoggedIn = await checkIfAlreadyLoggedIn(page, config);
        const cookies = await page.cookies();
        const hasSessionCookie = cookies.some(c => c.name === 'sessionKey' || c.name === 'routingHint');

        if ((isLoggedIn || hasSessionCookie) && currentPolling >= 15) {
          clearInterval(spinnerInterval);
          process.stdout.write('\n');
          console.log(chalk.green(`[browser] ✅ 로그인 성공 감지 (magic-link 자동 처리 완료)`));
          success = true;
          break;
        }

        await delay(1000);
      }

      if (success) {
        console.log(chalk.green.bold("\n=================================================="));
        console.log(chalk.green.bold("🎉 브라우저 세션 내에서 로그인 성공!"));
        console.log(chalk.green.bold("==================================================\n"));

        const cookies = await page.cookies();
        logCoreCookies(cookies);
        console.log("");
        return;
      }

      clearInterval(spinnerInterval);
      process.stdout.write('\n');

      // 인증코드 추출 (자동 로그인 안 된 경우 fallback)
      const code = await extractVerificationCodeFromPage(page);
      if (!code) {
        console.error(chalk.red("❌ [browser] 에러: 인증코드를 추출하지 못했습니다."));
        return;
      }

      console.log(chalk.green(`[browser] ✅ 인증코드 추출 성공: ${chalk.bold(code)}`));
      saveLatestClaudeCode(config.latestClaudeCodePath, { code, source: "interactive-only", timestamp: Date.now() });

      // Step 4: verify_magic_link 호출
      console.log(chalk.cyan(`\n[Step 4] [verify] verify_magic_link 호출 준비 (Code: ${code})`));
      const result = await verifyMagicLinkWithCycleTls(config, email, code);

      if (result.ok) {
        console.log(chalk.green.bold("\n=================================================="));
        console.log(chalk.green.bold("🎉 브라우저 세션 내에서 로그인 성공!"));
        console.log(chalk.green.bold("==================================================\n"));
        
        const cookies = await page.cookies();
        logCoreCookies(cookies);
        console.log("");
      } else {
        console.error(chalk.red.bold("\n=================================================="));
        console.error(chalk.red.bold(`❌ verify_magic_link 실패: ${result.reason}`));
        console.error(chalk.red(`사유: ${result.message || "알 수 없는 오류"}`));
        console.error(chalk.red.bold("==================================================\n"));
      }
    } finally {
      console.log(chalk.cyan("[browser] 브라우저 세션을 종료합니다."));
      await browser.close().catch(() => {});
      await shutdownCycleTls();
      process.exit(0);
    }
  } catch (error) {
    console.error(chalk.red(`\n[LOGIN] ❌ 치명적 오류 발생: ${error.message}`));
  } finally {
    await shutdownCycleTls();
    process.exit(1);
  }
}

/**
 * 이메일 주소를 마스킹 처리한다.
 */
function maskEmail(email) {
    if (!email || typeof email !== 'string') return email;
    const [name, domain = ""] = email.split("@");
    if (!name) return email;
    if (name.length <= 2) return `${name[0]}*@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
}

/**
 * 로그인 성공 여부 체크 (magic-link가 자동 처리된 경우)
 */
async function checkIfAlreadyLoggedIn(page, config) {
  const url = await page.url();
  const title = await page.title();

  return (
    url.includes("/new") ||
    url.includes("/chat") ||
    title === "Claude" ||
    title.includes("Claude") ||
    (await page.evaluate(() => document.querySelector('textarea') !== null)) // Claude 입력창 존재 여부
  );
}

/**
 * 핵심 세션 쿠키 정보를 로그로 출력한다.
 */
function logCoreCookies(cookies) {
    if (!cookies || !Array.isArray(cookies)) return;

    const coreKeys = ['sessionKey', 'routingHint', 'lastActiveOrg', 'cf_clearance', '__cf_bm', 'activitySessionId'];
    const filtered = cookies.filter(c => coreKeys.includes(c.name));

    console.log(chalk.magenta(`\n[인증 성공] 🍪 핵심 세션 쿠키 정보:`));
    filtered.forEach(c => {
        const val = c.value;
        const maskedVal = val.length > 15 ? `${val.substring(0, 12)}...` : val;
        console.log(chalk.magenta(`${c.name}: ${chalk.white(maskedVal)}`));
    });
}

/**
 * 강화된 인증코드 추출 함수
 */
async function extractVerificationCodeFromPage(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || "";

    // 1. 6자리 코드
    let match = text.match(/\b(\d{6})\b/);
    if (match) return match[1];

    // 2. 5자리 코드
    match = text.match(/\b(\d{5})\b/);
    if (match) return match[1];

    // 3. input 필드에서 직접 찾기
    const inputs = document.querySelectorAll('input');
    for (const input of inputs) {
      const value = input.value.trim();
      if (/^\d{5,6}$/.test(value)) return value;
    }

    return null;
  });
}

runInteractiveLogin().catch(console.error);
