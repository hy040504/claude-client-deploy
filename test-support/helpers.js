import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { fromProjectRoot } from "../src/shared/paths.js";

/**
 * 실제 계정 파일과 분리된 테스트 저장소를 만든다.
 * @param {import("node:test").TestContext} t - 테스트 컨텍스트
 * @returns {object} 임시 경로와 기본 설정
 */
export function fixture(t) {
  const root = resolve(fromProjectRoot("tmp", "tests"));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "case-"));
  t.after(() => {
    if (!resolve(directory).startsWith(`${root}${sep}`)) throw new Error("테스트 정리 경로가 잘못되었습니다.");
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    accountsPath: join(directory, "accounts.json"),
    accountsDataPath: join(directory, "accounts"),
    accountId: "default",
    gmailAuthMode: "direct",
    gmailClientId: "test-client",
    gmailClientSecret: "test-secret",
    gmailRefreshToken: "legacy-token",
    gmailRelaySessionToken: "legacy-session",
    gmailUserEmail: "legacy@example.com",
    claudeLoginEmail: "legacy@example.com",
    capturedCookie: "sessionKey=legacy",
    capturedHeaders: "legacy-headers",
    orgId: "legacy-org",
    jarPath: join(directory, "legacy-jar.json"),
    statePath: join(directory, "legacy-state.json"),
    lastChatPath: join(directory, "legacy-chat.json"),
    latestClaudeCodePath: join(directory, "legacy-code.json"),
    profilePath: join(directory, "legacy-profile")
  };
}

/**
 * relay 규격을 실제 HTTP로 검증할 로컬 모의 서버를 연다.
 * @param {import("node:test").TestContext} t - 테스트 컨텍스트
 * @param {Function} handler - 요청 처리 함수
 * @returns {Promise<string>} 로컬 서버 주소
 */
export async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
