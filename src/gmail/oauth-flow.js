import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { google } from "googleapis";
import { readGmailClientCredentials } from "./gmail-client.js";
import { fromProjectRoot } from "../shared/paths.js";

const gmailReadonlyScope = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * 로컬 OAuth 콜백으로 Gmail refresh token을 발급받는다.
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object>} 발급된 OAuth 토큰 정보
 * @throws {Error} OAuth 콜백 또는 토큰 교환이 실패할 때 발생
 */
export async function authorizeGmail(config) {
  const { clientId, clientSecret } = readGmailClientCredentials(config);
  const callback = await createOAuthCallbackServer(config);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, callback.redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [gmailReadonlyScope]
  });

  console.log("아래 URL을 브라우저에서 열고 Google 로그인을 완료하세요.");
  console.log(authUrl);
  console.log(`\nOAuth 콜백 대기 중: ${callback.redirectUri}`);

  try {
    const code = await callback.waitForCode();
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token || null;
    const envUpdated = refreshToken ? updateDotEnvValue(fromProjectRoot(".env"), "GMAIL_REFRESH_TOKEN", refreshToken) : false;

    return {
      ok: true,
      redirectUri: callback.redirectUri,
      scope: gmailReadonlyScope,
      refreshToken,
      envUpdated,
      envPath: fromProjectRoot(".env"),
      accessTokenIssued: Boolean(tokens.access_token),
      expiryDate: tokens.expiry_date || null
    };
  } finally {
    callback.close();
  }
}

/**
 * Google OAuth redirect를 받을 임시 로컬 서버를 연다.
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object>} 콜백 서버 제어 객체
 */
export function createOAuthCallbackServer(config) {
  const port = config.gmailAuthPort || 3000;
  const path = config.gmailAuthPath || "/oauth2callback";
  const bindHost = config.gmailAuthBindHost || "0.0.0.0";
  const authHost = config.gmailAuthHost || "127.0.0.1";
  const redirectUri = `http://${authHost}:${port}${path}`;

  return new Promise((resolve, reject) => {
    let finish;
    let fail;
    const codePromise = new Promise((innerResolve, innerReject) => {
      finish = innerResolve;
      fail = innerReject;
    });

    const server = createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (url.pathname !== path) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Google OAuth failed. You can close this tab.");
        fail(new Error(`Google OAuth error: ${error}`));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Missing OAuth code. You can close this tab.");
        fail(new Error("OAuth callback에 code가 없습니다."));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Gmail OAuth token issued. You can close this tab.");
      finish(code);
    });

    server.on("error", reject);
    server.listen(port, bindHost, () => {
      resolve({
        redirectUri,
        waitForCode: () => codePromise,
        close: () => server.close()
      });
    });
  });
}

/**
 * .env 파일의 특정 값을 갱신하거나 없으면 추가한다.
 * @param {string} path - .env 파일 경로
 * @param {string} key - 갱신할 환경 변수 이름
 * @param {string} value - 저장할 환경 변수 값
 * @returns {boolean} 갱신 성공 여부
 */
export function updateDotEnvValue(path, key, value) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  let replaced = false;
  const nextLines = lines.map(line => {
    if (line.trimStart().startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }

    return line;
  });

  if (!replaced) {
    if (nextLines.length && nextLines.at(-1) !== "") nextLines.push("");
    nextLines.push(`${key}=${value}`);
  }

  writeFileSync(path, nextLines.join("\n").replace(/\n*$/, "\n"));
  return true;
}
