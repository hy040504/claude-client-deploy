import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createAppConfig } from "../src/config/app-config.js";
import { createRuntime } from "../src/runtime/create-runtime.js";
import { addAccount, selectAccount } from "../src/accounts/account-store.js";
import { fixture } from "../test-support/helpers.js";
import { fromProjectRoot } from "../src/shared/paths.js";

/**
 * 임시 계정 저장소로 실제 실행 파일을 호출한다.
 * @param {object} config - 테스트 경로
 * @param {string[]} args - Node 실행 인자
 * @param {object} options - 환경 변수와 메뉴 입력
 * @returns {Promise<object>} 종료 코드와 출력
 */
function run(config, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: fromProjectRoot(),
      env: {
        ...process.env,
        ACCOUNTS_PATH: config.accountsPath,
        ACCOUNTS_DATA_PATH: config.accountsDataPath,
        CLAUDE_ACCOUNT: "",
        ...options.env
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const steps = [...(options.steps || [])];
    let cursor = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI 테스트 시간 초과"));
    }, 30000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (steps.length) {
        const [prompt, answer] = steps[0];
        const index = stdout.indexOf(prompt, cursor);
        if (index >= 0) {
          cursor = index + prompt.length;
          steps.shift();
          child.stdin.write(`${answer}\n`);
        }
      }
      if (options.menuExit && stdout.includes("선택>")) {
        child.stdin.write("0\n");
        options.menuExit = false;
      }
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("CLI에서 계정을 추가·선택하고 실행 시 옵션으로만 덮어쓸 수 있다", async t => {
  const config = fixture(t);
  const added = await run(config, ["index.js", "account-add", "work", "work@example.com", "relay"]);
  assert.equal(added.code, 0, added.stderr);
  const selected = await run(config, ["index.js", "account-use", "work"]);
  assert.equal(JSON.parse(selected.stdout).activeAccountId, "work");
  const listed = await run(config, ["index.js", "account-list"]);
  const listing = JSON.parse(listed.stdout);
  assert.equal(listing.activeAccountId, "work");
  assert.equal(listing.accounts.find(account => account.id === "work").authenticated, false);
  assert.equal(/refreshToken|sessionToken|clientSecret/.test(listed.stdout), false);
  const override = await run(config, ["index.js", "--account", "default", "account-list"], {
    env: { CLAUDE_ACCOUNT: "work" }
  });
  assert.equal(JSON.parse(override.stdout).activeAccountId, "default");
  assert.equal(existsSync(config.accountsDataPath), false);
});

test("명시한 계정으로 만든 런타임은 기본 계정 전환 후에도 같은 경로에 저장한다", t => {
  const base = fixture(t);
  addAccount(base.accountsPath, { id: "a", email: "a@example.com" });
  addAccount(base.accountsPath, { id: "b", email: "b@example.com" });
  const config = createAppConfig({ ...base, accountId: "a" });
  const runtime = createRuntime({ config });
  selectAccount(base.accountsPath, "b");
  runtime.persistJar();
  runtime.persistState();
  assert.equal(runtime.config.accountId, "a");
  assert.equal(existsSync(config.jarPath), true);
  assert.equal(existsSync(createAppConfig({ ...base, accountId: "b" }).jarPath), false);
});

test("로그아웃은 해당 계정의 파일만 삭제하고 종료 시 다시 생성하지 않는다", async t => {
  const base = fixture(t);
  addAccount(base.accountsPath, { id: "a", email: "a@example.com" });
  addAccount(base.accountsPath, { id: "b", email: "b@example.com" });
  const a = createAppConfig({ ...base, accountId: "a" });
  const b = createAppConfig({ ...base, accountId: "b" });
  for (const config of [a, b]) {
    const runtime = createRuntime({ config });
    runtime.persistJar();
    runtime.persistState();
  }
  const result = await run(base, ["index.js", "--account", "a", "logout"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(a.jarPath), false);
  assert.equal(existsSync(a.statePath), false);
  assert.equal(existsSync(b.jarPath), true);
  assert.equal(existsSync(base.accountsPath), true);
});

test("새 실행 이름과 기존 호환 이름에서 도움말이 실행된다", async t => {
  const base = fixture(t);
  for (const filename of ["chat-cli.js", "chat-tui.js", "prompt-chat.js", "prompt-chat2.js"]) {
    const result = await run(base, [filename, "--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /--account/);
    assert.doesNotMatch(result.stdout, /prompt-chat2/);
  }
  assert.equal(existsSync(base.accountsPath), false);
});

test("CLI와 TUI 메뉴에 선택한 계정이 표시되고 종료된다", async t => {
  const base = fixture(t);
  addAccount(base.accountsPath, { id: "work", email: "work@example.com" });
  for (const filename of ["chat-cli.js", "chat-tui.js"]) {
    const result = await run(base, [filename, "--account", "work"], { menuExit: true });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /계정: work/);
    assert.match(result.stdout, /9\. 계정 추가/);
    assert.match(result.stdout, /10\. 현재 계정 Gmail 인증/);
  }
});

test("두 메뉴에서 계정을 추가·전환하고 새 계정으로 쿠키 저장 하위 명령을 실행한다", async t => {
  const base = fixture(t);
  for (const [filename, id] of [
    ["chat-cli.js", "plain"],
    ["chat-tui.js", "terminal"]
  ]) {
    const result = await run(base, [filename, "--account", "default"], {
      steps: [
        ["선택>", "9"],
        ["Enter 취소>", "+"],
        ["새 계정 ID>", id],
        ["Gmail 주소>", `${id}@example.com`],
        ["인증 방식 (direct/relay)", "direct"],
        ["Claude 로그인 주소", ""],
        ["선택>", "1"],
        ["선택>", "4"],
        ["Cookie header>", "sessionKey=local-test-only"],
        ["선택>", "0"]
      ]
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`계정: ${id}`));
    assert.equal(existsSync(createAppConfig({ ...base, accountId: id }).jarPath), true);
  }
});
