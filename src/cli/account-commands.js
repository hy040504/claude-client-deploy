import { addAccount, readAccountStore, selectAccount } from "../accounts/account-store.js";
import { createAppConfig } from "../config/app-config.js";
import { applyAccountConfig } from "../accounts/account-config.js";
import { hasGmailAuth } from "../gmail/gmail-client.js";

/**
 * 자격 증명을 노출하지 않고 계정 목록과 인증 여부를 반환한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {object[]} 계정 요약 목록
 */
export function listAccounts(config) {
  const store = readAccountStore(config.accountsPath);
  const base = createAppConfig({
    accountId: "default",
    accountsPath: config.accountsPath,
    accountsDataPath: config.accountsDataPath,
    accountStore: { activeAccountId: "default", accounts: [] }
  });
  const ids = ["default", ...store.accounts.filter(account => account.id !== "default").map(account => account.id)];
  return ids.map(id => {
    const current = applyAccountConfig(base, id, store);
    return {
      id,
      email: current.gmailUserEmail,
      claudeEmail: current.claudeLoginEmail,
      mode: current.gmailAuthMode,
      authenticated: hasGmailAuth(current),
      active: id === config.accountId
    };
  });
}

/**
 * 계정 관리 명령을 Claude 런타임 없이 처리한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string} command - 관리 명령
 * @param {string[]} args - 명령 인자
 * @returns {object} 비밀 값을 제외한 실행 결과
 * @throws {Error} 인자가 잘못되었거나 지원하지 않는 명령이면 발생
 */
export function runAccountCommand(config, command, args) {
  if (command === "account-list")
    return { ok: true, activeAccountId: config.accountId, accounts: listAccounts(config) };
  if (command === "account-use") {
    if (args.length !== 1) throw new Error("사용법: account-use <id>");
    return { ok: true, activeAccountId: selectAccount(config.accountsPath, args[0]) };
  }
  if (command === "account-add") {
    if (args.length < 2 || args.length > 4)
      throw new Error("사용법: account-add <id> <gmail-email> [direct|relay] [claude-email]");
    const account = addAccount(config.accountsPath, {
      id: args[0],
      email: args[1],
      mode: args[2] || config.gmailAuthMode,
      claudeEmail: args[3]
    });
    return { ok: true, account };
  }
  throw new Error(`지원하지 않는 계정 명령: ${command}`);
}
