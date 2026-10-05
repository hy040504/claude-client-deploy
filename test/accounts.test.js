import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { addAccount, readAccountStore, selectAccount, saveAccountCredentials } from "../src/accounts/account-store.js";
import { applyAccountConfig } from "../src/accounts/account-config.js";
import { parseAccountOptions } from "../src/cli/account-options.js";
import { hasGmailAuth } from "../src/gmail/gmail-client.js";
import { fixture } from "../test-support/helpers.js";

test("기존 default 계정은 경로와 인증을 유지하고 읽기만으로 파일을 생성하지 않는다", t => {
  const base = fixture(t);
  const config = applyAccountConfig(base);
  assert.equal(config.accountId, "default");
  assert.equal(config.jarPath, base.jarPath);
  assert.equal(config.gmailRefreshToken, "legacy-token");
  assert.equal(existsSync(base.accountsPath), false);
});

test("계정 전환 시 Gmail token과 Claude 쿠키·프로필·이어쓰기를 분리한다", t => {
  const base = fixture(t);
  addAccount(base.accountsPath, { id: "personal", email: "personal@example.com" });
  addAccount(base.accountsPath, { id: "work", email: "work@example.com", mode: "relay" });
  selectAccount(base.accountsPath, "personal");
  const personal = applyAccountConfig(base);
  const work = applyAccountConfig(base, "work");
  assert.equal(personal.gmailRefreshToken, "");
  assert.equal(personal.gmailRelaySessionToken, "");
  assert.equal(personal.capturedCookie, "");
  assert.equal(personal.capturedHeaders, "");
  assert.equal(personal.orgId, undefined);
  for (const key of ["jarPath", "statePath", "lastChatPath", "latestClaudeCodePath", "profilePath"]) {
    assert.notEqual(personal[key], work[key]);
    assert.notEqual(personal[key], base[key]);
  }
  assert.equal(work.gmailAuthMode, "relay");
  assert.equal(work.gmailUserEmail, "work@example.com");
  assert.equal(readAccountStore(base.accountsPath).activeAccountId, "personal");
});

test("인증 결과는 선택한 주소에만 저장하고 다른 계정의 token을 보존한다", t => {
  const base = fixture(t);
  addAccount(base.accountsPath, { id: "a", email: "a@example.com" });
  addAccount(base.accountsPath, { id: "b", email: "b@example.com" });
  const a = applyAccountConfig(base, "a");
  const b = applyAccountConfig(base, "b");
  saveAccountCredentials(a, "a@example.com", { mode: "direct", refreshToken: "a-token" });
  assert.throws(
    () => saveAccountCredentials(b, "a@example.com", { mode: "direct", refreshToken: "wrong" }),
    /다릅니다/
  );
  saveAccountCredentials(b, "b@example.com", {
    mode: "relay",
    sessionToken: "b-session",
    serverUrl: "https://relay.example.com"
  });
  assert.equal(applyAccountConfig(base, "a").gmailRefreshToken, "a-token");
  assert.equal(applyAccountConfig(base, "b").gmailRefreshToken, "");
  assert.equal(applyAccountConfig(base, "b").gmailRelaySessionToken, "b-session");
});

test("default의 새 인증은 계정 저장소를 사용하고 기존 환경 token을 대체한다", t => {
  const base = fixture(t);
  saveAccountCredentials(base, "legacy@example.com", {
    mode: "relay",
    sessionToken: "new-session",
    serverUrl: "https://relay.example.com"
  });
  const config = applyAccountConfig(base);
  assert.equal(config.gmailRefreshToken, "");
  assert.equal(config.gmailRelaySessionToken, "new-session");
  assert.equal(config.jarPath, base.jarPath);
});

test("잘못된 ID, 중복 계정, 손상된 저장소는 거부하고 파일을 유지한다", t => {
  const base = fixture(t);
  for (const id of ["../outside", "a/b", "A", "default", "__proto__", "con", "nul", "com1", ""]) {
    assert.throws(() => addAccount(base.accountsPath, { id, email: "a@example.com" }));
  }
  addAccount(base.accountsPath, { id: "a", email: "a@example.com" });
  assert.throws(() => addAccount(base.accountsPath, { id: "a", email: "b@example.com" }), /이미/);
  assert.throws(() => selectAccount(base.accountsPath, "missing"), /등록되지/);
  assert.throws(() => applyAccountConfig(base, "missing"), /등록되지/);
  writeFileSync(base.accountsPath, "broken");
  assert.throws(() => selectAccount(base.accountsPath, "default"));
  assert.equal(readFileSync(base.accountsPath, "utf8"), "broken");
  assert.equal(existsSync(`${base.accountsPath}.lock`), false);
});

test("다른 프로세스가 쓰는 계정 파일을 덮어쓰지 않는다", t => {
  const base = fixture(t);
  writeFileSync(`${base.accountsPath}.lock`, "");
  assert.throws(() => addAccount(base.accountsPath, { id: "a", email: "a@example.com" }), { code: "EEXIST" });
  assert.equal(existsSync(base.accountsPath), false);
});

test("계정 옵션은 명령 이전에서만 해석해 채팅 내용이 옵션으로 소비되지 않는다", () => {
  assert.deepEqual(parseAccountOptions(["--account", "work", "chat-new", "--account"]), {
    accountId: "work",
    args: ["chat-new", "--account"]
  });
  assert.deepEqual(parseAccountOptions(["--account=work", "help"]), { accountId: "work", args: ["help"] });
  assert.throws(() => parseAccountOptions(["--account"]));
  assert.throws(() => parseAccountOptions(["--account=a", "--account=b"]));
});

test("선택한 공급자의 인증만 검사하고 process.env 토큰으로 우회하지 않는다", t => {
  const base = fixture(t);
  assert.equal(
    hasGmailAuth({
      ...base,
      gmailAuthMode: "relay",
      gmailRelayServerUrl: "https://relay.example.com",
      gmailRelaySessionToken: ""
    }),
    false
  );
  assert.equal(hasGmailAuth({ ...base, gmailRefreshToken: "" }), false);
  assert.throws(() => hasGmailAuth({ ...base, gmailAuthMode: "unknown" }));
});
