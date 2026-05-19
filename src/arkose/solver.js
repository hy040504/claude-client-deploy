import chalk from "chalk";
import axios from "axios";
import { setTimeout as delay } from "node:timers/promises";
import { solveWithPyArkose } from "./py-arkose-solver.js";
import { createCycleTlsHttpClient } from "../http/cycletls-client.js";
import { loadBrowserState } from "../state/browser-state.js";
import { loadJar } from "../state/cookie-jar.js";

/**
 * 설정된 외부 solver로 Arkose 토큰 발급을 시도한다. (하이브리드 모드)
 * @param {object} config - Arkose solver 설정
 * @param {string} [arkoseBlobOrToken] - Arkose가 요구하는 데이터 (c= 값 또는 이미 발급된 토큰)
 * @returns {Promise<string>} solver 응답 토큰 또는 직접 추출된 토큰
 */
export async function callArkoseSolver(config, arkoseBlobOrToken = null) {
    const publicKey = config.arkosePublicKey || "EEA5F558-D6AC-4C03-B678-AABF639EE69A";

    if (config.arkoseEnabled === false) {
        console.log(chalk.yellow("[arkose] 설정에 의해 Arkose가 비활성화되었습니다."));
        return null;
    }

    let currentInput = arkoseBlobOrToken;
    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount <= maxRetries) {
        if (!currentInput) {
            console.log(chalk.cyan(`[arkose] 데이터 추출 시도 중... (시도 ${retryCount + 1}/${maxRetries + 1})`));
            currentInput = await fetchArkoseBlob(config);
        }

        if (currentInput) {
            // 🔥 하이브리드 체크: 직접 추출된 것이 이미 토큰 형태(긴 문자열 또는 특정 구분자 포함)라면 바로 반환
            if (currentInput.includes('|') || currentInput.length > 100) {
                console.log(chalk.green(`[arkose] ✅ 직접 확보한 session token을 사용합니다. (Solver 우회)`));
                return currentInput;
            }

            // c= blob 형태인 경우에만 Python Solver 호출
            console.log(chalk.cyan(`[arkose] c= blob 감지 → Python Solver 호출 중...`));
            const pyToken = await solveWithPyArkose(currentInput, publicKey);
            if (pyToken && !pyToken.startsWith("dummy-py")) {
                return pyToken;
            }
            console.log(chalk.yellow(`[arkose] Python Solver 토큰 생성 실패 (${pyToken}) → 재시도 중...`));
        } else {
            console.log(chalk.yellow(`[arkose] 데이터 추출 실패 → 재시도 중...`));
        }

        retryCount++;
        if (retryCount <= maxRetries) {
            await delay(retryCount * 3000);
            currentInput = null; // 재시도 시 새 데이터 추출 유도
        }
    }

    console.log(chalk.red("[arkose] ❌ Arkose 처리 최종 실패 → 더미 토큰 우회"));
    return `dummy-py-arkose-fallback-${Date.now()}`;
}

/**
 * Arkose blob (c= 값) 또는 즉시 발급된 토큰 추출
 * CycleTLS 우선 + axios fallback + 하이브리드 파싱
 */
export async function fetchArkoseBlob(config) {
  const publicKey = config.arkosePublicKey || 'EEA5F558-D6AC-4C03-B678-AABF639EE69A';
  const url = `https://a-cdn.claude.ai/fc/gt2/public_key/${publicKey}`;

  console.log(chalk.cyan(`\n[arkose] 🔐 Arkose Public Key 요청 및 데이터 추출 시도... (Hybrid)`));

  // 1. 인간적인 동작을 위한 지연 (3초)
  await delay(3000);

  const state = loadBrowserState(config.statePath);
  const jar = loadJar(config.jarPath);
  const cycleTlsHttp = createCycleTlsHttpClient(config, state, jar, () => {});

  const browserHeaders = {
    "User-Agent": config.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "identity",
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": "https://claude.ai/",
    "Origin": "https://claude.ai",
    "Connection": "keep-alive"
  };

  const payload = `public_key=${publicKey}`;

  // 1. CycleTLS 시도
  try {
    const response = await cycleTlsHttp.post(url, payload, { 
      headers: browserHeaders,
      disableRedirect: false 
    });

    const bodyText = typeof response?.body === 'string' ? response.body : JSON.stringify(response?.body || "");
    
    if (response && response.status === 200 && bodyText.trim().length > 10) {
      // Case A: 세션 토큰 직접 발견 (우선)
      try {
        const bodyObj = typeof response.body === 'object' ? response.body : JSON.parse(bodyText);
        if (bodyObj && bodyObj.token) {
          console.log(chalk.green(`[arkose] ✅ CycleTLS: session token 직접 발견!`));
          return bodyObj.token;
        }
      } catch (e) {}

      // Case B: c= blob 추출
      const cMatch = bodyText.match(/c=([^"&'\s]+)/) || bodyText.match(/"c"\s*:\s*"([^"]+)"/);
      if (cMatch && cMatch[1]) {
        console.log(chalk.green(`[arkose] ✅ CycleTLS: c= blob 추출 성공!`));
        return cMatch[1];
      }
    } else {
      const displayBody = bodyText.trim() === "" ? "(empty)" : (bodyText.length > 50 ? bodyText.substring(0, 50) + "..." : bodyText);
      console.log(chalk.yellow(`[arkose] ⚠️ CycleTLS body empty (Status: 200, Body: ${displayBody}) → axios fallback 진행`));
    }

  } catch (e) {
    console.log(chalk.yellow(`[arkose] CycleTLS 에러: ${e.message} → axios 폴백`));
  }

  // 2. axios fallback
  console.log(chalk.cyan(`[arkose] axios 폴백 실행 중...`));
  await delay(3000);
  try {
    const response = await axios.post(url, payload, {
      headers: browserHeaders,
      timeout: 20000,
      validateStatus: () => true
    });

    if (response.status === 200 && response.data) {
      const data = response.data;
      const dataText = typeof data === 'string' ? data : JSON.stringify(data);

      // Step A: 토큰 확인
      if (data && data.token) {
        console.log(chalk.green(`[arkose] ✅ axios: Arkose session token 직접 추출 성공!`));
        return data.token;
      }

      // Step B: blob 확인
      const cMatch = dataText.match(/c=([^"&'\s]+)/) || dataText.match(/"c"\s*:\s*"([^"]+)"/);
      if (cMatch && cMatch[1]) {
        console.log(chalk.green(`[arkose] ✅ axios: Arkose c= blob 추출 성공!`));
        return cMatch[1];
      }
    }
    console.error(chalk.red(`[arkose] ❌ axios 최종 실패 (상태: ${response.status})`));
  } catch (e) {
    console.error(chalk.red(`[arkose] ❌ 모든 시도 실패: ${e.message}`));
  }

  return null;
}
