import { validateAccountId } from "../accounts/account-store.js";

/**
 * 명령 뒤의 메시지 인자와 구분되도록 선행 계정 옵션만 해석한다.
 * @param {string[]} argv - 실행 인자
 * @returns {{accountId: string|undefined, args: string[]}} 계정과 나머지 인자
 * @throws {Error} 계정 옵션 값이 없거나 중복되면 발생
 */
export function parseAccountOptions(argv) {
  const args = [...argv];
  let accountId;
  while (args[0] === "--account" || args[0]?.startsWith("--account=")) {
    if (accountId) throw new Error("--account는 한 번만 지정하세요.");
    const option = args.shift();
    accountId = validateAccountId(option === "--account" ? args.shift() : option.slice(10));
  }
  return { accountId, args };
}
