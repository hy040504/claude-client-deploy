import { join } from "node:path";
import { readAccountStore, validateAccountId } from "./account-store.js";

/**
 * 선택한 계정의 인증 정보와 Claude 상태 경로를 고정한다.
 * @param {object} config - 공통 환경 설정
 * @param {string} requestedId - 실행에서 명시한 계정 ID
 * @param {object} [store] - 목록 조회 시 파일을 다시 읽지 않기 위한 계정 저장소 스냅샷
 * @returns {object} 계정별 애플리케이션 설정
 * @throws {Error} 선택한 계정이 등록되지 않았으면 발생
 */
export function applyAccountConfig(config, requestedId, store = readAccountStore(config.accountsPath)) {
  const id = validateAccountId(requestedId || store.activeAccountId);
  const account = store.accounts.find(item => item.id === id);
  if (!account && id !== "default") throw new Error(`등록되지 않은 계정: ${id}. 먼저 account-add 명령으로 추가하세요.`);
  const isolated = id !== "default";
  const gmail = account?.gmail;
  const sessionPath = join(config.accountsDataPath, id);
  const mode = gmail?.mode || config.gmailAuthMode;
  if (!["direct", "relay"].includes(mode)) throw new Error("GMAIL_AUTH_MODE는 direct 또는 relay여야 합니다.");
  return {
    ...config,
    accountId: id,
    claudeLoginEmail: account?.claudeEmail ?? (isolated ? "" : config.claudeLoginEmail),
    gmailUserEmail: account?.email ?? (isolated ? "" : config.gmailUserEmail),
    gmailAuthMode: mode,
    gmailRefreshToken: gmail ? gmail.refreshToken || "" : isolated ? "" : config.gmailRefreshToken,
    gmailRelaySessionToken: gmail ? gmail.sessionToken || "" : isolated ? "" : config.gmailRelaySessionToken,
    gmailRelayServerUrl: gmail?.serverUrl || config.gmailRelayServerUrl,
    ...(isolated
      ? {
          orgId: undefined,
          capturedCookie: "",
          capturedHeaders: "",
          jarPath: join(sessionPath, "session-cookie-jar.json"),
          statePath: join(sessionPath, "client-state.json"),
          lastChatPath: join(sessionPath, "last-chat.json"),
          latestClaudeCodePath: join(sessionPath, "latest-claude-code.json"),
          profilePath: join(sessionPath, "browser-profile")
        }
      : {})
  };
}
