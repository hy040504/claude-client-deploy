import { createCycleTlsHttpClient } from "../http/cycletls-client.js";
import { loadBrowserState, saveBrowserState } from "../state/browser-state.js";
import { loadJar, saveJar } from "../state/cookie-jar.js";
import { callArkoseSolver } from "../arkose/solver.js";
import chalk from "chalk";
import axios from "axios";
import { setTimeout as delay } from "node:timers/promises";

// ==================== 최신 인증코드 저장 ====================
const latestClaudeVerificationCodes = new Map();

/**
 * 최신 Claude 인증 코드를 프로세스 안에 보관한다.
 * @param {string} code - 저장할 인증 코드
 * @param {string} [accountId="default"] - 인증 코드를 구분해 보관할 계정 ID
 * @returns {string} 저장된 인증 코드
 */
export function persistLatestClaudeCode(code, accountId = "default") {
  latestClaudeVerificationCodes.set(accountId, code);
  console.log(chalk.green(`[auth] ✅ 최신 Claude 인증 코드가 보관되었습니다: [인증 코드 숨김]`));
  return code;
}

/**
 * 최근에 저장된 Claude 인증 코드를 반환한다.
 * @param {string} [accountId="default"] - 확인할 계정 ID
 * @returns {string|null} 저장된 인증 코드
 */
export function getLatestClaudeVerificationCode(accountId = "default") {
  return latestClaudeVerificationCodes.get(accountId) || null;
}

/**
 * 로그인 링크의 # 뒤에 담긴 일회용 nonce와 인코딩된 이메일을 분리한다.
 * @param {string} magicLinkUrl - 메일에서 읽은 로그인 링크
 * @returns {object} nonce와 인코딩된 이메일
 * @throws {Error} 링크에 필요한 인증 정보가 없는 경우
 */
export function parseMagicLinkUrl(magicLinkUrl) {
  const url = new URL(magicLinkUrl);
  if (url.protocol !== "https:" || url.hostname !== "claude.ai" || url.username || url.password) {
    throw new Error("Claude의 HTTPS 로그인 링크가 필요합니다.");
  }
  const hash = url.hash.slice(1);
  if (!hash) throw new Error("Magic Link URL에 #nonce:email 부분이 없습니다.");
  const [nonce, encodedEmail] = hash.split(":");
  if (!nonce || !encodedEmail) throw new Error("Magic Link URL 형식이 올바르지 않습니다.");
  return { nonce, encodedEmail };
}

/**
 * 로그인 링크의 nonce를 서버에 보내 입력용 인증 코드로 교환한다.
 * @param {string} magicLinkUrl - 인증 정보가 담긴 로그인 링크
 * @param {object} [options={}] - 인증 코드를 보관할 accountId
 * @returns {Promise<object>} 인증 코드와 원본 응답
 * @throws {Error} 링크 형식, 네트워크 또는 서버 응답에 문제가 있는 경우
 */
export async function exchangeNonceForCode(magicLinkUrl, options = {}) {
  const { nonce, encodedEmail } = parseMagicLinkUrl(magicLinkUrl);
  const payload = {
    nonce,
    encoded_email_address: encodedEmail,
    source: "claude"
  };

  const headers = {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    Origin: "https://claude.ai",
    Referer: magicLinkUrl.split("#")[0],
    "anthropic-client-version": "1.0.0",
    "anthropic-client-platform": "web_claude_ai",
    "anthropic-client-sha": "d654b177072ef206f44e115bdc7a5849e8070c61",
    Accept: "*/*",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty"
  };

  try {
    console.log(chalk.magenta(`\n[verify] 🔍 exchange_nonce_for_code 실제 요청`));
    console.log(chalk.magenta(`Method: POST`));
    console.log(chalk.magenta(`URL: https://claude.ai/api/auth/exchange_nonce_for_code`));

    const response = await axios.post("https://claude.ai/api/auth/exchange_nonce_for_code", payload, {
      headers,
      timeout: 15000
    });

    if (response.data?.code) {
      console.log(chalk.green(`✅ 인증번호 획득 성공: [인증 코드 숨김]`));
      persistLatestClaudeCode(response.data.code, options.accountId);
      return { success: true, code: response.data.code, raw: response.data };
    } else {
      throw new Error("응답에 code 필드가 없습니다.");
    }
  } catch (error) {
    console.log(chalk.red(`\n[verify] ❌ 응답 실패 상세`));
    console.log(chalk.red(`Status: ${error.response?.status || "Error"}`));

    if (error.response?.status === 403 || error.response?.data?.toString().includes("challenge")) {
      console.error(chalk.red("⚠️ Cloudflare Challenge 발생!"));
    }
    throw error;
  }
}

/**
 * 로그인 요청이 한 가지 브라우저 지문에 고정되지 않도록 User-Agent를 고른다.
 * @returns {string} 선택된 User-Agent
 */
function getRandomUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

/**
 * 응답 본문에 인증 코드가 직접 포함된 예외적인 경우를 처리한다.
 * @param {string} body - 검사할 응답 본문
 * @returns {string|null} 추출된 인증 코드
 */
function extractVerificationCodeFromResponse(body) {
  if (!body || typeof body !== "string") return null;

  // 6자리 숫자 코드 찾기
  let match = body.match(/\b(\d{6})\b/);
  if (match) return match[1];

  // JSON 형태일 경우
  match = body.match(/"code"\s*:\s*"?(\d{6})"?/);
  if (match) return match[1];

  return null;
}

/**
 * 현재 계정으로 로그인 메일을 요청하고 서버가 요구할 때만 추가 인증 경로를 시도한다.
 * @param {object} config - 계정 인증과 상태 저장 경로
 * @param {string|object} input - 이메일 주소 또는 이메일을 포함한 요청 옵션
 * @returns {Promise<object>} 요청 성공 여부와 실패 사유
 */
export async function requestMagicLinkWithCycleTls(config, input) {
  const options = typeof input === "string" ? { email: input } : input || {};
  const email = options.email || options.email_address;
  if (!email) return { ok: false, reason: "missing_email" };

  const mode = config.forceMode || "full";
  if (mode === "no-arkose") config = { ...config, arkoseEnabled: false };

  const state = loadBrowserState(config.statePath);
  const jar = loadJar(config.jarPath);
  const persistJar = saveJar.bind(null, config.jarPath, jar);
  const persistState = saveBrowserState.bind(null, config.statePath, state);

  const http = createCycleTlsHttpClient(config, state, jar, persistJar);

  /**
   * 요청 제한 응답을 받으면 대기 시간을 늘려 같은 메일 요청을 재시도한다.
   * @param {string|null} token - 추가 인증에서 받은 토큰 또는 null
   * @returns {Promise<object>} 메일 발송 요청 결과
   */
  const attemptSend = async (token = null) => {
    let backoff = 60000;
    let retries = 0;
    const maxBackoffRetries = 2;

    while (retries <= maxBackoffRetries) {
      try {
        const response = await http.post(
          "/api/auth/send_magic_link",
          {
            utc_offset: currentTimezoneOffsetMinutes(),
            email_address: email,
            login_intent: null,
            locale: config.locale || "ko-KR",
            return_to: null,
            source: "claude",
            arkose_session_token: token
          },
          {
            responseType: "text",
            headers: {
              Accept: "application/json, text/plain, */*",
              Referer: `${config.baseUrl}/login`,
              Origin: config.baseUrl,
              "Content-Type": "application/json",
              "anthropic-client-platform": "web_claude_ai"
            }
          }
        );

        persistState();

        if (response.status >= 200 && response.status < 300) {
          console.log(`[login] ✅ Magic Link 요청 성공! (Arkose: ${token ? "Used" : "None"})`);
          return { ok: true, status: response.status };
        } else if (response.status === 429 && retries < maxBackoffRetries) {
          console.log(
            chalk.yellow(`[login] ⚠️ 429 Rate Limit 감지! ${backoff / 1000}초 대기 후 재시도... (${retries + 1})`)
          );
          await delay(backoff);
          backoff *= 2;
          retries++;
          continue;
        }
        return { ok: false, status: response.status, body: response.body };
      } catch (e) {
        if (e.response?.status === 429 && retries < maxBackoffRetries) {
          await delay(backoff);
          backoff *= 2;
          retries++;
          continue;
        }
        return { ok: false, reason: "exception", message: e.message };
      }
    }
    return { ok: false, reason: "max_retries_exceeded" };
  };

  // ==================== 1순위: Arkose 없이 시도 ====================
  let firstAttemptResult = null;
  if (mode !== "with-arkose") {
    console.log("[arkose] 1순위 → Arkose 없이 Magic Link 요청 시도...");
    firstAttemptResult = await attemptSend(null);
    if (firstAttemptResult.ok) return firstAttemptResult;
  }

  // ==================== 2순위: Solver 사용 ====================
  if (config.arkoseEnabled !== false) {
    console.log("[arkose] 2순위 → Solver로 Arkose 해결 시도...");
    try {
      const arkoseToken = await callArkoseSolver(config);
      if (arkoseToken) {
        const result = await attemptSend(arkoseToken);
        if (result.ok) return result;
      }
    } catch (err) {
      console.log(`[arkose] Solver 예외: ${err.message}`);
    }
  }

  return firstAttemptResult || { ok: false, reason: "failed_all_attempts" };
}

/**
 * 메일의 인증 코드를 검증하고 반환된 로그인 쿠키를 현재 계정에 저장한다.
 * @param {object} config - 계정 인증과 상태 저장 경로
 * @param {string} email - 로그인할 이메일 주소
 * @param {string} code - 메일에서 확보한 인증 코드
 * @param {string|null} arkoseSessionToken - 이미 확보한 추가 인증 토큰
 * @returns {Promise<object>} 인증 성공 여부와 실패 사유
 */
export async function verifyMagicLinkWithCycleTls(config, email, code, arkoseSessionToken = null) {
  console.log(
    chalk.cyan(
      `[verify] 함수 진입 - Email: ${chalk.blue(email)}, Code: [인증 코드 숨김], Token: ${arkoseSessionToken ? "exists" : "null"}`
    )
  );

  // 세션 쿠키가 발급 직후 서버에 반영될 시간을 둔다.
  console.log(chalk.cyan(`[verify] 세션 안정화를 위해 6초 대기 중...`));
  await delay(6000);

  console.log(chalk.cyan(`[verify] arkoseEnabled: ${config.arkoseEnabled}, forceMode: ${config.forceMode}`));

  if (!email || typeof email !== "string" || !email.includes("@")) {
    console.log(chalk.red(`\n[verify] ❌ Error: email is null or invalid → ${email}`));
    return { ok: false, reason: "invalid_email" };
  }

  const mode = config.forceMode || "full";
  if (mode === "no-arkose") config = { ...config, arkoseEnabled: false };

  const state = loadBrowserState(config.statePath);
  const jar = loadJar(config.jarPath);
  const persistJar = saveJar.bind(null, config.jarPath, jar);
  const persistState = saveBrowserState.bind(null, config.statePath, state);

  const http = createCycleTlsHttpClient(config, state, jar, persistJar);

  persistLatestClaudeCode(code, config.accountId);

  console.log(chalk.cyan(`\n[verify] CycleTLS로 verify_magic_link 시도`));
  console.log(chalk.cyan(`[verify] ----------------------------------------`));
  console.log(chalk.cyan(`[verify] Target Email: ${chalk.blue(email)}`));
  console.log(chalk.cyan(`[verify] ----------------------------------------\n`));

  /**
   * 인증 코드 검증 요청을 보내고 제한 응답에 한해 간격을 늘려 재시도한다.
   * @param {string|null} token - 요청에 포함할 추가 인증 토큰
   * @returns {Promise<object>} 인증 응답 요약
   */
  const attemptVerify = async token => {
    let backoff = 60000; // 60초부터 시작
    let retries = 0;
    const maxBackoffRetries = 3;

    while (retries <= maxBackoffRetries) {
      try {
        console.log(chalk.cyan(`[verify] >>> 실제 HTTP 요청 시작 <<< (Arkose Token: ${token ? "Present" : "None"})`));

        const payload = {
          credentials: {
            method: "code",
            email_address: String(email).trim(),
            code: String(code).trim()
          },
          locale: config.locale || "ko-KR",
          source: "claude",
          arkose_session_token: token || null
        };

        console.log(chalk.magenta(`[verify] 🔍 실제 요청 정보`));
        console.log(chalk.magenta(`Method: POST`));
        console.log(chalk.magenta(`URL: /api/auth/verify_magic_link`));

        const response = await http.post("/api/auth/verify_magic_link", payload, {
          responseType: "json",
          headers: {
            "Content-Type": "application/json",
            "anthropic-client-platform": "web_claude_ai",
            Origin: config.baseUrl,
            Referer: `${config.baseUrl}/login`
          }
        });

        persistState();

        console.log(chalk.magenta(`[verify] 📥 verify_magic_link 응답 수신`));
        console.log(chalk.magenta(`Status: ${response.status}`));

        if (response.status >= 200 && response.status < 300) {
          console.log(chalk.green(`[login] [verify] ✅ verify_magic_link 성공! (Status: ${response.status})`));
          return {
            ok: true,
            data: response.data,
            status: response.status,
            usedArkose: !!token
          };
        } else if (response.status === 429 && retries < maxBackoffRetries) {
          console.log(
            chalk.red(
              `[verify] ⚠️ 429 Rate Limit 감지! ${backoff / 1000}초 대기 후 재시도... (${retries + 1}/${maxBackoffRetries})`
            )
          );
          await delay(backoff);
          backoff *= 2; // 요청 제한을 다시 만나면 대기 시간을 두 배로 늘린다.
          retries++;
          continue;
        } else {
          console.log(chalk.yellow(`[verify] ⚠️ API 응답 실패: ${response.status}`));

          console.log(chalk.red(`[verify] ❌ 응답 실패 상세`));
          console.log(chalk.red(`Status: ${response.status}`));

          return {
            ok: false,
            status: response.status,
            data: response.data,
            message: response.data?.error?.message || "Unknown API error"
          };
        }
      } catch (e) {
        if (e.response?.status === 429 && retries < maxBackoffRetries) {
          console.log(chalk.red(`[verify] ⚠️ 429 Rate Limit 예외 감지! ${backoff / 1000}초 대기 후 재시도...`));
          await delay(backoff);
          backoff *= 2;
          retries++;
          continue;
        }
        console.log(chalk.red(`[verify] ❌ API 요청 중 예외 발생: ${e.message}`));
        return { ok: false, reason: "exception", message: e.message, status: "exception", data: e.response?.data };
      }
    }
    return { ok: false, reason: "max_retries_exceeded", status: 429, data: "Max retries reached with 429" };
  };

  // 1순위: 전달된 토큰이 있거나, 토큰 없이 먼저 시도
  let result = { ok: false, status: "not_attempted" };

  // 이미 확보한 토큰이 있으면 새 토큰을 발급받지 않고 사용한다.
  if (mode === "with-arkose" && !arkoseSessionToken) {
    console.log(chalk.yellow("[verify] [TEST] with-arkose 모드 및 토큰 없음: 1차 시도 건너뜀"));
  } else {
    result = await attemptVerify(arkoseSessionToken);
  }

  if (result.ok) return result;

  // 2순위: 실패했고, 아직 Solver를 사용하지 않았으며, 설정상 활성화되어 있다면 Solver 호출 후 재시도
  if (config.arkoseEnabled !== false && !arkoseSessionToken) {
    console.log(chalk.yellow("\n[arkose] [verify] ⚠️ 1차 시도 실패 또는 Arkose 요구됨 → 세션 토큰 확보 시도..."));
    try {
      // callArkoseSolver 내부에서 fetchArkoseBlob을 통해 직접 토큰을 가져옴
      const newToken = await callArkoseSolver(config);

      if (newToken && !newToken.startsWith("dummy-py")) {
        console.log(chalk.magenta(`\n[arkose] 🛡️ Arkose Token Secured (Direct or Solved)!`));
        console.log(chalk.magenta(`[arkose] ----------------------------------------`));
        console.log(chalk.magenta(`[arkose] ----------------------------------------\n`));

        console.log(chalk.cyan(`[arkose] [verify] 토큰 확보 성공 → 2차 시도 시작`));
        result = await attemptVerify(newToken);
        return result;
      }
    } catch (err) {
      console.log(chalk.red(`[arkose] [verify] ❌ 토큰 확보 실패: ${err.message}`));
      return { ok: false, reason: "solver_failed", message: err.message, lastResult: result };
    }
  }

  return {
    ok: false,
    reason: "verify_failed",
    status: result.status,
    message: result.message,
    lastResult: result
  };
}

/**
 * 로그인 링크를 열어 인증 코드를 얻고 같은 계정의 쿠키 저장소에 검증 결과를 반영한다.
 * @param {object} config - 계정 설정
 * @param {string|null} email - 로그인 이메일 또는 링크에서 읽을 경우 null
 * @param {string} magicLinkUrl - 메일에서 얻은 인증 링크
 * @returns {Promise<object>} 인증 결과와 브라우저 재시도에 필요한 정보
 */
export async function openVerificationLinkWithCycleTls(config, email, magicLinkUrl) {
  try {
    console.log(chalk.cyan(`[gmail] [verify] CycleTLS로 인증 링크 접속 시도: [인증 링크 숨김]`));

    const state = loadBrowserState(config.statePath);
    const jar = loadJar(config.jarPath);
    const persistJar = saveJar.bind(null, config.jarPath, jar);
    const http = createCycleTlsHttpClient(config, state, jar, persistJar);

    const response = await http.get(magicLinkUrl, {
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://claude.ai/",
        Origin: "https://claude.ai"
      }
    });

    const status = response.status;
    const bodyText = typeof response.data === "string" ? response.data : JSON.stringify(response.data || "");
    const bodySnippet = bodyText ? bodyText.substring(0, 200).replace(/\n/g, " ") : "(비어있음)";

    console.log(chalk.cyan(`[gmail] [verify] 응답 상태(Status): ${status}, 본문 요약: ${bodySnippet}`));

    // Arkose 관련 'c=' 값 또는 설정 데이터가 있는지 확인하여 상세 로그 출력
    if (bodyText && bodyText.includes("c=")) {
      const cMatch = bodyText.match(/c\s*:\s*["']([^"']+)["']/);
      if (cMatch) {
        console.log(chalk.magenta(`\n[arkose] 🛡️ 응답에서 Arkose 챌린지 감지!`));
        console.log(chalk.magenta(`[arkose] ----------------------------------------`));
        console.log(chalk.magenta(`[arkose] ----------------------------------------\n`));
      }
    }

    if (status !== 200) {
      console.log(chalk.yellow(`[gmail] [verify] 매직 링크 열기 실패 (상태 코드: ${status})`));
      return { ok: false, reason: "magic_link_status_not_200", status };
    }

    let code = null;

    // attempt 1: URL hash에서 추출 시도 (exchange_nonce_for_code 호출)
    if (new URL(magicLinkUrl).hash) {
      console.log(chalk.cyan(`[gmail] [verify] 코드 자동 교환 시도 (nonce exchange) 시작...`));
      try {
        const exchangeResult = await exchangeNonceForCode(magicLinkUrl, { accountId: config.accountId });
        if (exchangeResult?.success) {
          code = exchangeResult.code;
        }
      } catch (e) {
        console.log(chalk.red(`[gmail] [verify] 코드 교환 실패: ${e.message}`));
      }
      console.log(chalk.cyan(`[gmail] [verify] 코드 자동 교환 결과: ${code || "실패"}`));
    }

    if (!code) {
      console.log(chalk.yellow(`[gmail] [verify] ⚠️ 인증 실패: Cloudflare Challenge 또는 기타 오류`));
    }

    // attempt 2: response body에서 6자리 숫자 패턴 검색
    if (!code) {
      console.log(chalk.cyan(`[gmail] [verify] 코드 추출 시도 2 (본문 패턴 검색) 시작...`));
      code = extractVerificationCodeFromResponse(bodyText);
      console.log(chalk.cyan(`[gmail] [verify] 코드 추출 시도 2 결과: ${code || "실패"}`));
    }

    if (!code) {
      console.log(chalk.yellow(`[gmail] [verify] 모든 시도 후에도 응답에서 인증 코드를 찾지 못했습니다.`));
      return { ok: false, reason: "verification_code_not_found", status };
    }

    console.log(chalk.green(`[gmail] [verify] ✅ 인증 코드 추출 성공: [인증 코드 숨김]`));

    // 메일 감시와 HTTP 로그인 모두 같은 계정 이메일로 코드를 검증해야 한다.
    const result = await verifyMagicLinkWithCycleTls(
      config,
      email || config.claudeLoginEmail || config.gmailUserEmail,
      code
    );
    return { ...result, code };
  } catch (error) {
    console.error(chalk.red(`[gmail] [verify] CycleTLS 인증 프로세스 에러:`), error.message);
    return { ok: false, reason: "internal_error", error: error.message };
  }
}

/**
 * Claude 인증 API가 기대하는 현재 timezone 오프셋을 계산한다.
 * @param {string} timezone - IANA timezone 이름
 * @returns {number} UTC 기준 오프셋(분)
 */
function currentTimezoneOffsetMinutes(timezone) {
  if (!timezone) return new Date().getTimezoneOffset();
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  return Math.round((now.getTime() - local.getTime()) / 60000);
}
