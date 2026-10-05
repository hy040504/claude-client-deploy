import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthCallbackServer, authorizeGmailViaRelay } from "../src/gmail/oauth-flow.js";
import { findLatestClaudeMail, findLatestDirectMail } from "../src/gmail/latest-claude-mail.js";
import { validateRelayUrl, fetchRelayLatestMail } from "../src/gmail/relay-client.js";
import { addAccount, readAccountStore } from "../src/accounts/account-store.js";
import { applyAccountConfig } from "../src/accounts/account-config.js";
import { fixture, serve } from "../test-support/helpers.js";

test("OAuth callback은 state 불일치를 거부하고 올바른 코드만 반환한다", async t => {
  const callback = await createOAuthCallbackServer({ gmailAuthPort: 0, gmailAuthTimeoutMs: 2000 });
  t.after(callback.close);
  const wrong = await fetch(`${callback.redirectUri}?code=wrong&state=wrong`);
  assert.equal(wrong.status, 400);
  const noCode = await fetch(`${callback.redirectUri}?state=${callback.state}`);
  assert.equal(noCode.status, 400);
  const right = await fetch(`${callback.redirectUri}?code=expected&state=${callback.state}`);
  assert.equal(right.status, 200);
  assert.equal(await callback.waitForCode(), "expected");
});

test("OAuth 취소와 시간 초과를 처리하고 서버를 정리한다", async t => {
  const cancelled = await createOAuthCallbackServer({ gmailAuthPort: 0, gmailAuthTimeoutMs: 1000 });
  t.after(cancelled.close);
  const rejection = assert.rejects(cancelled.waitForCode(), /access_denied/);
  await fetch(`${cancelled.redirectUri}?error=access_denied&state=${cancelled.state}`);
  await rejection;
  const timeout = await createOAuthCallbackServer({ gmailAuthPort: 0, gmailAuthTimeoutMs: 20 });
  t.after(timeout.close);
  await assert.rejects(timeout.waitForCode(), /초과/);
});

test("relay OAuth 결과를 해당 계정에만 저장하고 출력 결과에 token을 포함하지 않는다", async t => {
  const base = fixture(t);
  addAccount(base.accountsPath, { id: "work", email: "work@example.com", mode: "relay" });
  const requests = [];
  const url = await serve(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/auth/start"
          ? { sessionId: "test/session", authUrl: "https://accounts.google.com/oauth?state=mock", expiresInMs: 1000 }
          : { status: "authorized", email: "work@example.com", sessionToken: "work-secret" }
      )
    );
  });
  const config = { ...applyAccountConfig(base, "work"), gmailRelayServerUrl: url, gmailRelayApiKey: "test-key" };
  const result = await authorizeGmailViaRelay(config);
  assert.equal(JSON.stringify(result).includes("work-secret"), false);
  assert.equal(readAccountStore(base.accountsPath).accounts[0].gmail.sessionToken, "work-secret");
  assert.equal(JSON.parse(requests[0].body).userEmail, "work@example.com");
  assert.equal(requests[0].headers["x-api-key"], "test-key");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].path, "/api/auth/session/test%2Fsession");
});

test("relay 메일 조회는 요청별 token과 검색 옵션을 격리한다", async t => {
  const seen = [];
  const url = await serve(t, (req, res) => {
    seen.push({ auth: req.headers.authorization, url: new URL(req.url, "http://localhost") });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ messageId: req.headers.authorization, internalDate: 100, verificationLinks: [], text: "Claude" })
    );
  });
  const config = {
    gmailAuthMode: "relay",
    gmailRelayServerUrl: url,
    gmailClaudeQuery: "from:anthropic.com",
    gmailClaudeMaxResults: 7
  };
  const results = await Promise.all([
    findLatestClaudeMail({ ...config, gmailRelaySessionToken: "a" }, { allowMissing: true }),
    findLatestClaudeMail({ ...config, gmailRelaySessionToken: "b" }, { query: "newer_than:1d", maxResults: 2 })
  ]);
  assert.equal(results[0].messageId, "Bearer a");
  assert.equal(results[1].messageId, "Bearer b");
  const accountA = seen.find(request => request.auth === "Bearer a");
  const accountB = seen.find(request => request.auth === "Bearer b");
  assert.equal(accountB.url.searchParams.get("query"), "newer_than:1d");
  assert.equal(accountB.url.searchParams.get("maxResults"), "2");
  assert.equal(accountA.url.searchParams.get("query"), "from:anthropic.com");
  assert.equal(accountA.url.searchParams.get("maxResults"), "7");
  assert.equal(accountA.url.searchParams.get("allowMissing"), "true");
});

test("relay 인증 누락 시 직접 Gmail로 fallback하지 않는다", async () => {
  await assert.rejects(
    findLatestClaudeMail({
      gmailAuthMode: "relay",
      gmailClientId: "id",
      gmailClientSecret: "secret",
      gmailRefreshToken: "token"
    }),
    /relay 인증/
  );
});

test("relay의 null·HTTP 오류·잘못된 JSON·시간 초과를 구분한다", async t => {
  let mode = "null";
  const url = await serve(t, (req, res) => {
    if (mode === "timeout") return;
    if (mode === "error") {
      res.writeHead(401).end("secret-server-details");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(mode === "null" ? "null" : "broken");
  });
  const config = { gmailRelayServerUrl: url, gmailRelaySessionToken: "secret" };
  assert.equal(await fetchRelayLatestMail(config, { allowMissing: true }), null);
  await assert.rejects(fetchRelayLatestMail(config), /찾지 못/);
  mode = "error";
  await assert.rejects(fetchRelayLatestMail(config), /401/);
  mode = "invalid";
  await assert.rejects(fetchRelayLatestMail(config), /JSON/);
  mode = "timeout";
  await assert.rejects(fetchRelayLatestMail({ ...config, requestTimeoutMs: 20 }), { name: "TimeoutError" });
});

test("relay URL 검증으로 원격 HTTP와 URL 내 자격 증명을 거부한다", () => {
  for (const url of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
    "file:///tmp/server"
  ]) {
    assert.throws(() => validateRelayUrl(url));
  }
  assert.equal(validateRelayUrl("http://127.0.0.1:1234").hostname, "127.0.0.1");
});

test("직접 Gmail 조회는 선택 계정을 전달하고 MIME 링크와 코드를 추출한다", async () => {
  const seen = [];
  const client = {
    userId: "work@example.com",
    gmail: {
      users: {
        messages: {
          /**
           * 선택한 계정이 Gmail 목록 요청에 사용되는지 확인할 인자를 기록한다.
           * @param {object} args - Gmail 목록 요청 인자
           * @returns {Promise<object>} 고정 메일 ID가 담긴 모의 응답
           */
          list: async args => {
            seen.push(args);
            return { data: { messages: [{ id: "mail" }] } };
          },
          /**
           * 계정별 메일 조회를 기록하고 MIME 해석용 본문을 반환한다.
           * @param {object} args - Gmail 상세 조회 인자
           * @returns {Promise<object>} 테스트용 메일 본문
           */
          get: async args => {
            seen.push(args);
            return {
              data: {
                id: "mail",
                internalDate: "123",
                payload: {
                  headers: [{ name: "From", value: "Claude <no-reply@anthropic.com>" }],
                  parts: [
                    { mimeType: "text/plain", body: { data: Buffer.from("Claude code 123456").toString("base64url") } },
                    {
                      mimeType: "text/html",
                      body: {
                        data: Buffer.from('<a href="https://claude.ai/login?token=test">로그인</a>').toString(
                          "base64url"
                        )
                      }
                    }
                  ]
                }
              }
            };
          }
        }
      }
    }
  };
  const mail = await findLatestDirectMail({}, { maxResults: 5 }, client);
  assert.equal(mail.verificationCode, "123456");
  assert.equal(mail.verificationLinks.length, 1);
  assert.equal(seen[0].userId, "work@example.com");
  assert.equal(seen[1].userId, "work@example.com");
  await assert.rejects(findLatestDirectMail({}, { maxResults: NaN }, client), /maxResults/);
});
