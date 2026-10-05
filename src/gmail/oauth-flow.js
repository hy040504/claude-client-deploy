import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { google } from "googleapis";
import { gmailAuthMode, readGmailClientCredentials } from "./gmail-client.js";
import { pollRelayAuthSession, startRelayAuthSession } from "./relay-client.js";
import { saveAccountCredentials } from "../accounts/account-store.js";

const gmailReadonlyScope = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * 선택된 계정의 Gmail 인증 방식을 실행한다.
 * @param {object} config - 계정 설정
 * @param {string} modeArg - 명시적으로 지정한 인증 방식
 * @returns {Promise<object>} 비밀 값을 제외한 인증 결과
 */
export async function authorizeGmail(config, modeArg) {
  const mode = gmailAuthMode({ ...config, gmailAuthMode: modeArg || config.gmailAuthMode });
  return mode === "relay" ? authorizeGmailViaRelay(config) : authorizeGmailDirect(config);
}

/**
 * Google에서 확인한 주소와 선택된 계정이 일치할 때만 토큰을 저장한다.
 * @param {object} config - 계정 설정
 * @returns {Promise<object>} 인증 결과
 * @throws {Error} OAuth 실패, 계정 불일치 또는 refresh token 누락 시 발생
 */
export async function authorizeGmailDirect(config) {
  const { clientId, clientSecret } = readGmailClientCredentials(config);
  const callback = await createOAuthCallbackServer(config);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, callback.redirectUri);
  const verifier = randomBytes(32).toString("base64url");
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: [gmailReadonlyScope],
    state: callback.state,
    login_hint: config.gmailUserEmail || undefined,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256"
  });
  try {
    console.error(`브라우저에서 선택한 Gmail 계정으로 인증하세요:\n${authUrl}`);
    const code = await callback.waitForCode();
    const { tokens } = await oauth2Client.getToken({ code, codeVerifier: verifier });
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const sameMailbox = config.gmailUserEmail?.toLowerCase() === profile.data.emailAddress?.toLowerCase();
    const refreshToken = tokens.refresh_token || (sameMailbox ? config.gmailRefreshToken : "");
    if (!refreshToken) throw new Error("refresh token이 발급되지 않았습니다. Google 동의 화면에서 다시 인증하세요.");
    const account = saveAccountCredentials(config, profile.data.emailAddress, { mode: "direct", refreshToken });
    return { ok: true, mode: "direct", accountId: account.id, email: account.email, accountsPath: config.accountsPath };
  } finally {
    callback.close();
  }
}

/**
 * relay 서버의 인증 세션을 기다리고 계정별 접근 토큰을 저장한다.
 * @param {object} config - 계정 설정
 * @returns {Promise<object>} 비밀 값을 제외한 인증 결과
 * @throws {Error} 인증 실패 또는 제한 시간 초과 시 발생
 */
export async function authorizeGmailViaRelay(config) {
  const started = await startRelayAuthSession(config);
  console.error(`브라우저에서 Gmail 계정으로 인증하세요:\n${started.authUrl}`);
  const timeoutMs = Math.min(started.expiresInMs || 300000, config.gmailAuthTimeoutMs || 300000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await pollRelayAuthSession(
      {
        ...config,
        requestTimeoutMs: Math.min(config.requestTimeoutMs || 30000, Math.max(1, deadline - Date.now()))
      },
      started.sessionId
    );
    if (current.status === "authorized") {
      if (!current.sessionToken || !current.email)
        throw new Error("relay 인증 응답에 토큰 또는 Gmail 주소가 없습니다.");
      const account = saveAccountCredentials(config, current.email, {
        mode: "relay",
        sessionToken: current.sessionToken,
        serverUrl: config.gmailRelayServerUrl
      });
      return {
        ok: true,
        mode: "relay",
        accountId: account.id,
        email: account.email,
        accountsPath: config.accountsPath
      };
    }
    if (["error", "expired", "denied"].includes(current.status)) throw new Error(`relay 인증 실패: ${current.status}`);
    if (current.status !== "pending") throw new Error("알 수 없는 relay 인증 상태입니다.");
    await delay(Math.min(config.gmailRelayPollMs || 2500, Math.max(1, deadline - Date.now())));
  }
  throw new Error("relay Gmail 인증 대기 시간이 초과되었습니다.");
}

/**
 * state 검증과 제한 시간이 있는 로컬 OAuth callback 서버를 연다.
 * @param {object} config - callback 주소와 대기 시간 설정
 * @returns {Promise<object>} redirect URI, state, 코드 대기 및 종료 함수
 * @throws {Error} 서버 시작 실패 또는 잘못된 callback 설정 시 발생
 */
export async function createOAuthCallbackServer(config) {
  const host = config.gmailAuthHost || "127.0.0.1";
  const bindHost = config.gmailAuthBindHost || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    throw new Error("직접 OAuth callback 주소는 로컬 loopback이어야 합니다.");
  const path = config.gmailAuthPath || "/oauth2callback";
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path)) throw new Error("OAuth callback 경로를 확인하세요.");
  const state = randomBytes(32).toString("hex");
  let finish;
  let fail;
  let timer;
  const codePromise = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // 서버 시작 직후 취소돼도 처리되지 않은 Promise 거부가 남지 않게 한다.
  codePromise.catch(() => {});
  const server = createServer(handleCallback);

  /**
   * 잘못된 callback은 거부하고 올바른 인증 응답만 대기자에게 전달한다.
   * @param {import("node:http").IncomingMessage} request - callback 요청
   * @param {import("node:http").ServerResponse} response - callback 응답
   * @returns {void} 반환값 없음
   */
  function handleCallback(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || url.pathname !== path) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end("OAuth state mismatch");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) {
      response.writeHead(400).end("Google 인증이 취소되었습니다. 터미널로 돌아가세요.");
      fail(new Error(`Google OAuth 실패: ${error}`));
    } else if (!code) {
      response.writeHead(400).end("Missing OAuth code");
      return;
    } else {
      response.writeHead(200).end("인증 응답을 받았습니다. 터미널에서 저장 결과를 확인하세요.");
      finish(code);
    }
    clearTimeout(timer);
    server.close();
  }

  /**
   * 취소 시 열린 서버와 대기 중인 인증을 함께 정리한다.
   * @returns {void} 반환값 없음
   */
  function close() {
    clearTimeout(timer);
    fail(new Error("OAuth callback 대기가 종료되었습니다."));
    server.close();
    server.closeAllConnections();
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.gmailAuthPort ?? 3000, bindHost, resolve);
  });
  const redirectUri = `http://${host}:${server.address().port}${path}`;
  timer = setTimeout(() => {
    fail(new Error("Google OAuth 인증 대기 시간이 초과되었습니다."));
    server.close();
    server.closeAllConnections();
  }, config.gmailAuthTimeoutMs || 300000);
  /**
   * callback에서 검증한 인증 코드를 기다린다.
   * @returns {Promise<string>} OAuth 인증 코드
   */
  function waitForCode() {
    return codePromise;
  }
  return { redirectUri, state, waitForCode, close };
}
