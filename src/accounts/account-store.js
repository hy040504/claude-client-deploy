import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 계정 ID가 저장 경로 밖으로 벗어나지 않도록 제한한다.
 * @param {string} id - 계정 ID
 * @returns {string} 검증된 계정 ID
 * @throws {Error} ID 형식이 올바르지 않으면 발생
 */
export function validateAccountId(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id || "") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) {
    throw new Error("계정 ID는 영문 소문자·숫자로 시작하는 1~64자의 소문자, 숫자, _, -만 허용합니다.");
  }
  return id;
}

/**
 * 손상된 계정 파일을 빈 저장소로 덮어쓰지 않도록 검증해서 읽는다.
 * @param {string} path - 계정 저장소 경로
 * @returns {object} 계정 저장소
 * @throws {Error} 파일 형식이 올바르지 않으면 발생
 */
export function readAccountStore(path) {
  if (!existsSync(path)) return { version: 1, activeAccountId: "default", accounts: [] };
  const store = JSON.parse(readFileSync(path, "utf8"));
  if (store.version !== 1 || !Array.isArray(store.accounts)) throw new Error("지원하지 않는 계정 저장소 형식입니다.");
  validateAccountId(store.activeAccountId);
  const ids = new Set();
  for (const account of store.accounts) {
    validateAccountId(account.id);
    if (ids.has(account.id)) throw new Error("계정 저장소에 중복 ID가 있습니다.");
    ids.add(account.id);
    if (!isEmail(account.email) || !isEmail(account.claudeEmail))
      throw new Error("계정 저장소의 이메일 형식이 잘못되었습니다.");
    if (!account.gmail || !["direct", "relay"].includes(account.gmail.mode))
      throw new Error("계정 저장소의 Gmail 인증 방식이 잘못되었습니다.");
  }
  if (store.activeAccountId !== "default" && !ids.has(store.activeAccountId))
    throw new Error("활성 계정이 저장소에 없습니다.");
  return store;
}

/**
 * 동시 쓰기와 중간 종료로 인한 토큰 파일 손상을 방지한다.
 * @param {string} path - 계정 저장소 경로
 * @param {Function} update - 저장소 변경 함수
 * @returns {object} 변경 후 저장소
 * @throws {Error} 다른 프로세스가 수정 중이거나 저장에 실패하면 발생
 */
function updateAccountStore(path, update) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const store = readAccountStore(path);
    update(store);
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, path);
    return store;
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * 기존 계정을 덮어쓰지 않고 새 프로필을 추가한다.
 * @param {string} path - 계정 저장소 경로
 * @param {object} account - ID, Gmail 주소, Claude 주소, 인증 방식
 * @returns {object} 추가된 계정
 * @throws {Error} ID 중복 또는 이메일 형식 오류 시 발생
 */
export function addAccount(path, account) {
  validateAccountId(account.id);
  if (account.id === "default") throw new Error("default는 기존 .env 계정에 예약된 ID입니다.");
  const email = String(account.email || "")
    .trim()
    .toLowerCase();
  const claudeEmail = String(account.claudeEmail || email)
    .trim()
    .toLowerCase();
  if (![email, claudeEmail].every(isEmail)) throw new Error("Gmail 주소와 Claude 로그인 주소를 확인하세요.");
  const mode = account.mode || "direct";
  if (!["direct", "relay"].includes(mode)) throw new Error("인증 방식은 direct 또는 relay입니다.");
  const profile = { id: account.id, email, claudeEmail, gmail: { mode } };
  updateAccountStore(path, store => {
    if (store.accounts.some(item => item.id === profile.id)) throw new Error("이미 등록된 계정 ID입니다.");
    store.accounts.push(profile);
  });
  return profile;
}

/**
 * 이메일에 공백이나 제어 문자가 섞이지 않도록 확인한다.
 * @param {string} value - 이메일 주소
 * @returns {boolean} 이메일 형식 여부
 */
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * 다음 실행에서 사용할 계정을 선택한다.
 * @param {string} path - 계정 저장소 경로
 * @param {string} id - 선택할 계정 ID
 * @returns {string} 선택된 계정 ID
 */
export function selectAccount(path, id) {
  validateAccountId(id);
  updateAccountStore(path, store => {
    if (id !== "default" && !store.accounts.some(account => account.id === id))
      throw new Error(`등록되지 않은 계정: ${id}`);
    store.activeAccountId = id;
  });
  return id;
}

/**
 * 인증한 Gmail 주소를 확인한 뒤 해당 계정의 자격 증명만 교체한다.
 * @param {object} config - 선택된 계정 설정
 * @param {string} email - 인증 서버가 확인한 Gmail 주소
 * @param {object} credentials - 저장할 Gmail 자격 증명
 * @returns {object} 저장된 계정
 * @throws {Error} 등록된 주소와 인증한 주소가 다르면 발생
 */
export function saveAccountCredentials(config, email, credentials) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!isEmail(normalized)) throw new Error("인증된 Gmail 주소를 확인하지 못했습니다.");
  if (config.gmailUserEmail && config.gmailUserEmail.toLowerCase() !== normalized)
    throw new Error("선택한 계정과 인증한 Gmail 주소가 다릅니다. 해당 Google 계정으로 다시 인증하세요.");
  validateAccountId(config.accountId);
  if (
    credentials.mode === "direct"
      ? !credentials.refreshToken
      : credentials.mode !== "relay" || !credentials.sessionToken || !credentials.serverUrl
  ) {
    throw new Error("저장할 Gmail 자격 증명이 올바르지 않습니다.");
  }
  let saved;
  updateAccountStore(config.accountsPath, store => {
    saved = store.accounts.find(account => account.id === config.accountId);
    if (!saved) {
      if (config.accountId !== "default") throw new Error("저장할 계정이 없습니다.");
      saved = { id: "default", email: normalized, claudeEmail: config.claudeLoginEmail || normalized };
      store.accounts.push(saved);
    }
    if (saved.email && saved.email !== normalized) throw new Error("계정 주소가 인증 도중 변경되었습니다.");
    saved.email = normalized;
    saved.gmail = credentials;
  });
  return saved;
}
