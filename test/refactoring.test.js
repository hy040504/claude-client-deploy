import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneBrowserProfile, removeBrowserProfileClone } from "../src/browser/real-browser.js";
import { fixture, serve } from "../test-support/helpers.js";
import { runLoginEntry } from "../src/cli/login-entry.js";
import { extractMessageContent } from "../src/gmail/message-parser.js";
import { isCurrentLoginMail, waitForLoginMail } from "../src/gmail/login-mail.js";
import {
  createClaudeMailReader,
  findLatestClaudeMail,
  findVerificationLinks
} from "../src/gmail/latest-claude-mail.js";
import { redact, redactUrl, formatCommandPreview } from "../src/shared/mask.js";
import { getLatestClaudeVerificationCode, persistLatestClaudeCode, parseMagicLinkUrl } from "../src/auth/magic-link.js";
import { fromProjectRoot } from "../src/shared/paths.js";
import { extractMessagesFromConversation, findLatestAssistantMessageUuid } from "../src/claude/conversation-data.js";

/**
 * MIME 순서를 바꿔도 같은 본문이 나오는지 확인할 테스트 항목을 만든다.
 * @param {string} mimeType - 본문 형식
 * @param {string} text - 인코딩 전 본문
 * @returns {object} Gmail MIME 항목
 */
function part(mimeType, text) {
  return { mimeType, body: { data: Buffer.from(text).toString("base64url") } };
}

/**
 * 오래된 메일과 새 메일을 구분하기 위한 고정 인증 메일을 만든다.
 * @param {number} internalDate - Gmail 수신 시각
 * @returns {object} 테스트용 인증 메일
 */
function loginMail(internalDate) {
  return {
    messageId: String(internalDate),
    internalDate,
    from: "Claude <no-reply@anthropic.com>",
    verificationLinks: [{ url: "https://claude.ai/magic-link#nonce:email" }]
  };
}

test("MIME 순서와 관계없이 일반 본문을 우선하고 HTML 버튼 링크는 보존한다", () => {
  const plain = part("text/plain", "인증 코드 123456");
  const html = part("text/html", '<a href="https://claude.ai/magic-link">로그인</a>');
  const attachment = { ...part("text/plain", "첨부 파일"), filename: "memo.txt" };
  const expected = { text: "인증 코드 123456", links: [{ text: "로그인", url: "https://claude.ai/magic-link" }] };
  assert.deepEqual(extractMessageContent({ parts: [html, plain, attachment] }), expected);
  assert.deepEqual(extractMessageContent({ parts: [plain, html] }), expected);
  assert.equal(extractMessageContent({ parts: [html] }).text, "로그인");
});

test("오래된 메일, 수신 시각 누락, 유사 발신자와 외부 인증 링크를 제외한다", () => {
  const now = Date.now();
  const mail = loginMail(now);
  assert.equal(isCurrentLoginMail(mail, now), true);
  for (const invalid of [
    loginMail(now - 120000),
    { ...mail, internalDate: undefined },
    { ...mail, internalDate: 0 },
    { ...mail, from: "no-reply@anthropic.com.evil.test" },
    { ...mail, verificationLinks: [{ url: "https://evil.test/claude.ai/login" }] }
  ]) {
    assert.equal(isCurrentLoginMail(invalid, now), false);
  }
  const links = [
    "https://claude.ai/magic-link#nonce:email",
    "https://claude.ai.evil.test/login",
    "http://claude.ai/login",
    "https://claude.ai/privacy",
    "https://user:secret@claude.ai/login"
  ].map(url => ({ url }));
  assert.deepEqual(findVerificationLinks({ links }), links.slice(0, 1));
});

test("메일 감시는 이전 메일을 건너뛰고 새 메일을 반환하며 중단 시 긴 대기를 취소한다", async () => {
  const sentAt = Date.now();
  const messages = [loginMail(sentAt - 60000), loginMail(sentAt)];
  /**
   * 호출마다 준비된 메일을 하나씩 반환한다.
   * @returns {Promise<object>} 다음 테스트 메일
   */
  async function readMail() {
    return messages.shift();
  }
  const result = await waitForLoginMail({}, sentAt, { readMail, timeoutMs: 2000, pollMs: 1 });
  assert.equal(result.internalDate, sentAt);
  const controller = new AbortController();
  /**
   * 메일이 없는 상태를 반환한 직후 중단 신호를 보낸다.
   * @returns {Promise<null>} 검색 결과 없음
   */
  async function readMissing() {
    setImmediate(controller.abort.bind(controller));
    return null;
  }
  await assert.rejects(
    waitForLoginMail({}, sentAt, { readMail: readMissing, timeoutMs: 30000, pollMs: 30000, signal: controller.signal }),
    { name: "AbortError" }
  );
});

test("직접 메일 감시는 선택한 클라이언트와 계정을 재사용하고 검색 조건과 중단 신호를 전달한다", async () => {
  const seen = [];
  /**
   * 네트워크 요청 없이 Gmail 호출 인자와 제한 시간을 기록한다.
   * @param {object} args - Gmail 검색 인자
   * @param {object} options - HTTP 제한 시간과 중단 신호
   * @returns {Promise<object>} 빈 메일 목록
   */
  async function list(args, options) {
    seen.push({ args, options });
    return { data: { messages: [] } };
  }
  const read = createClaudeMailReader(
    { gmailAuthMode: "direct", requestTimeoutMs: 1234 },
    { userId: "work@example.com", gmail: { users: { messages: { list } } } }
  );
  const controller = new AbortController();
  await read({ allowMissing: true, query: "first", signal: controller.signal });
  await read({ allowMissing: true, query: "second" });
  assert.deepEqual(
    seen.map(item => item.args.userId),
    ["work@example.com", "work@example.com"]
  );
  assert.deepEqual(
    seen.map(item => item.args.q),
    ["first", "second"]
  );
  assert.equal(seen[0].options.timeout, 1234);
  assert.equal(seen[0].options.signal, controller.signal);
});

test("공통 대화 파서는 블록 배열, id 필드, 순환 참조와 깊은 응답을 처리한다", () => {
  const assistant = { id: "answer", role: "assistant", content: [{ type: "text", text: "블록 답변" }] };
  let root = { messages: [assistant] };
  root.self = root;
  for (let i = 0; i < 12000; i += 1) root = { nested: root };
  assert.deepEqual(extractMessagesFromConversation(root), [{ role: "assistant", text: "블록 답변" }]);
  assert.equal(findLatestAssistantMessageUuid(root), "answer");
});

test("짧은 쿠키도 마스킹하고 메모리의 인증 코드는 계정별로 보관한다", () => {
  assert.equal(redact("123456"), "***");
  assert.equal(formatCommandPreview("seed-cookie", ["sessionKey=secret"]), "seed-cookie [쿠키 숨김]");
  assert.equal(
    redactUrl("https://user:secret@claude.ai/magic-link?email=secret#nonce:email"),
    "https://claude.ai/magic-link?[숨김]#[숨김]"
  );
  persistLatestClaudeCode("111111", "one");
  persistLatestClaudeCode("222222", "two");
  assert.equal(getLatestClaudeVerificationCode("one"), "111111");
  assert.equal(getLatestClaudeVerificationCode("two"), "222222");
  assert.deepEqual(parseMagicLinkUrl("https://claude.ai/magic-link#nonce:encoded-email"), {
    nonce: "nonce",
    encodedEmail: "encoded-email"
  });
  assert.throws(() => parseMagicLinkUrl("https://evil.test/magic-link#nonce:email"), /HTTPS 로그인 링크/);
});

test("공통 로그인 진입점은 계정과 모드를 전달하고 실패 종료 코드를 보존한다", async t => {
  const calls = [];
  const originalExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = originalExitCode;
  });
  /**
   * 실제 계정 파일을 읽지 않고 옵션을 기록한다.
   * @param {object} options - 명령행에서 해석한 계정 옵션
   * @returns {object} 로그인에 넘길 테스트 설정
   */
  function createConfig(options) {
    return { accountId: options.accountId, jarPath: "account-jar" };
  }
  /**
   * 브라우저를 열지 않고 전달된 로그인 설정을 기록한다.
   * @param {object} config - 고정된 계정과 로그인 모드
   * @returns {Promise<void>} 기록 완료
   */
  async function login(config) {
    calls.push(config);
  }
  await runLoginEntry("interactive", ["--account", "work"], { createConfig, login });
  assert.equal(calls[0].accountId, "work");
  assert.equal(calls[0].browserLoginMode, "interactive");
  assert.equal(calls[0].browserInteractiveHeadless, false);
  t.mock.method(console, "error", () => {});
  await runLoginEntry("background", ["--invalid"], { createConfig, login });
  assert.equal(process.exitCode, 1);
  assert.equal(calls.length, 1);
});

test("두 로그인 스크립트의 도움말은 계정 파일과 실제 로그인 없이 종료한다", async () => {
  for (const mode of ["background", "interactive"]) {
    const { stdout } = await promisify(execFile)(process.execPath, [`scripts/${mode}-login.js`, "--help"], {
      cwd: fromProjectRoot(),
      timeout: 10000,
      windowsHide: true
    });
    assert.match(stdout, /사용법:/);
    assert.match(stdout, /--account/);
  }
});

test("빨리 끝난 비동기 작업의 timeout 타이머가 프로세스 종료를 지연하지 않는다", async () => {
  const script =
    'import { withTimeout } from "./src/shared/async.js"; await withTimeout(Promise.resolve("done"), 60000, "timeout");';
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fromProjectRoot(),
    timeout: 5000,
    windowsHide: true
  });
});

test("임시 프로필만 정리하고 원본 프로필 삭제를 거부한다", t => {
  const { directory } = fixture(t);
  const original = join(directory, "Preferences");
  writeFileSync(original, "원본 설정");
  writeFileSync(join(directory, "LOCK"), "잠금");
  const clone = cloneBrowserProfile(directory);
  assert.equal(readFileSync(join(clone, "Preferences"), "utf8"), "원본 설정");
  assert.equal(existsSync(join(clone, "LOCK")), false);
  assert.throws(() => removeBrowserProfileClone(directory), /임시 브라우저 프로필/);
  removeBrowserProfileClone(clone);
  assert.equal(existsSync(clone), false);
  assert.equal(existsSync(original), true);
});

test("relay 응답 본문이 멈춰도 전체 메일 대기 시간과 사용자 중단 신호를 지킨다", async t => {
  let externalController;
  const url = await serve(t, (request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{");
    if (externalController) setImmediate(externalController.abort.bind(externalController));
  });
  const config = {
    gmailAuthMode: "relay",
    gmailRelayServerUrl: url,
    gmailRelaySessionToken: "test",
    requestTimeoutMs: 5000
  };
  assert.equal(await waitForLoginMail(config, Date.now(), { timeoutMs: 50 }), null);
  externalController = new AbortController();
  await assert.rejects(findLatestClaudeMail(config, { signal: externalController.signal }), { name: "AbortError" });
});
