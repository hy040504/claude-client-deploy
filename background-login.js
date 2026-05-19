/**
 * background-login.js
 * Background Headless Chrome 중심의 단순화된 로그인
 * 진짜 Headless 모드(창 숨김)와 독립적인 고속 스피너가 적용되었습니다.
 */

import { createAppConfig } from "./src/config/app-config.js";
import { connectRealBrowser } from "./src/browser/real-browser.js";
import { findLatestClaudeMail } from "./src/gmail/latest-claude-mail.js";
import { requestMagicLinkWithCycleTls } from "./src/auth/magic-link.js";
import { setTimeout as delay } from "node:timers/promises";
import chalk from "chalk";

const spinnerFrames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

async function runBackgroundLogin() {
  const config = createAppConfig();
  
  // 헤더 스타일링 (하늘색 bold)
  console.log(chalk.cyan.bold("\n=============================================="));
  console.log(chalk.cyan.bold("===       Background Headless 로그인       ==="));
  console.log(chalk.cyan.bold("==============================================\n"));

  const email = config.claudeLoginEmail || config.gmailUserEmail;
  if (!email) {
    console.error(chalk.red("[LOGIN] ❌ 에러: 로그인할 이메일이 설정되지 않았습니다."));
    process.exit(1);
  }

  // 이메일 마스킹 (앞 2글자 표시)
  const maskedEmail = email.replace(/^(..)(.*)(@.*)$/, "$1***$3");
  console.log(chalk.cyan(`[LOGIN] 대상 이메일: ${chalk.blue.bold(maskedEmail)}`));

  // Step 1: Magic Link 요청
  console.log(chalk.cyan("\n[Step 1] Magic Link 요청 시작..."));
  const sent = await requestMagicLinkWithCycleTls(config, { email, source: "claude" });
  if (!sent.ok) {
    console.error(chalk.red(`[Step 1] ❌ Magic Link 요청 실패: ${sent.reason || sent.status}`));
    process.exit(1);
  }
  console.log(chalk.green("[Step 1 완료] ✅ Magic Link 요청 성공"));

  // Step 2: Gmail에서 magic-link 기다리기
  console.log(chalk.cyan("\n[Step 2] Gmail 메일 대기 중..."));
  let mail = null;
  const mailStart = Date.now();
  // 최대 60초간 메일 대기
  while (Date.now() - mailStart < 60000) {
    mail = await findLatestClaudeMail(config, { allowMissing: true });
    if (mail?.verificationLinks?.[0]?.url) break;
    await delay(3000);
  }

  if (!mail?.verificationLinks?.[0]?.url) {
    console.error(chalk.red("[Step 2] ❌ magic-link를 찾지 못했습니다."));
    process.exit(1);
  }

  const magicLinkUrl = mail.verificationLinks[0].url;
  console.log(chalk.green("[Step 2 완료] ✅ magic-link URL 확보"));

  // Step 3: 진짜 Background Headless Chrome으로 magic-link 처리
  console.log(chalk.cyan(`\n[Step 3] Background Chrome으로 magic-link 처리 시작...`));
  
  // [강조] headless: true 및 background: true 강제 유지
  const { browser, page } = await connectRealBrowser(config, {
    userDataDir: config.profilePath || ".browser-profile",
    mode: "background",
    headless: true,
    background: true
  });

  try {
    await page.goto(magicLinkUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // Polling with independent fast spinner
    let success = false;
    let currentPolling = 1;
    let spinnerIndex = 0;

    // 스피너 업데이트를 위한 함수
    const updateProgress = () => {
      const frame = spinnerFrames[spinnerIndex];
      process.stdout.write(`\r[browser] 🔄 polling ${currentPolling.toString().padStart(3, '0')}/120 | magic-link 처리 중... ${frame}`);
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
    };

    // 스피너를 고속으로 돌리는 인터벌 (약 100ms)
    const spinnerInterval = setInterval(updateProgress, 100);

    for (currentPolling = 1; currentPolling <= 120; currentPolling++) {
      const url = await page.url();
      const title = await page.title();
      const cookies = await page.cookies();

      // 성공 조건: i >= 15 필수
      const isAppScreen = url.includes('/new') || url.includes('/chat') || title.includes('Claude');
      const hasSessionCookie = cookies.some(c => c.name === 'sessionKey' || c.name === 'routingHint');
      
      if ((isAppScreen || hasSessionCookie) && currentPolling >= 15) {
        clearInterval(spinnerInterval);
        process.stdout.write('\n');
        console.log(chalk.green(`[browser] ✅ Claude 앱 화면 또는 세션 쿠키 감지 성공!`));
        success = true;
        break;
      }

      await delay(1000); // 1초 대기 (이 동안 spinnerInterval이 스피너를 회전시킴)
    }

    if (!success) {
      clearInterval(spinnerInterval);
      process.stdout.write('\n');
      console.log(chalk.yellow("[browser] ⚠️ 120초 polling 후에도 세션이 안정화되지 않음"));
    }

    // 결과 출력 (성공 시 순서 변경: 배너 먼저, 쿠키 나중에)
    if (success) {
      console.log(chalk.green.bold("\n========================================"));
      console.log(chalk.green.bold("🎉 BACKGROUND HEADLESS 로그인 성공!"));
      console.log(chalk.green.bold("========================================"));

      console.log(chalk.magenta(`[인증 성공] 🍪 핵심 세션 쿠키 정보:`));

      const cookies = await page.cookies();
      const coreKeys = ["sessionKey", "routingHint", "lastActiveOrg", "cf_clearance", "__cf_bm", "activitySessionId"];

      coreKeys.forEach(key => {
        const cookie = cookies.find(c => c.name === key);
        if (cookie) {
          const val = cookie.value;
          const maskedVal = val.length > 20 ? `${val.substring(0, 20)}...` : val;
          console.log(chalk.magenta(`  ${key}: ${chalk.white(maskedVal)}`));
        }
      });
      console.log("");
    } else {
      console.log(chalk.red.bold("\n========================================"));
      console.log(chalk.red.bold("❌ BACKGROUND HEADLESS 로그인 실패"));
      console.log(chalk.red.bold("========================================\n"));
    }

  } catch (error) {
    console.error(chalk.red(`\n[browser] ❌ 오류 발생: ${error.message}`));
  } finally {
    if (browser) await browser.close().catch(() => {});
    
    // 성공 후 자동 종료 강제
    process.exit(0);
  }
}

runBackgroundLogin().catch(err => {
  console.error(chalk.red(`\n[LOGIN] 치명적 오류: ${err.message}`));
  process.exit(1);
});
