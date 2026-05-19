import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const blockedPathPatterns = [
  /^\.env$/,
  /^session-cookie-jar\.json$/,
  /^client-state\.json$/,
  /^last-chat\.json$/,
  /^\.browser-profile\//,
  /^node_modules\//,
  /^tmp\//,
  /^deploy\//,
  /^ubuntu\//,
  /^packet\//,
  /^Microsoft\//
];

const message = process.argv.slice(2).join(" ").trim() || `Update project ${new Date().toISOString()}`;

/**
 * git 업로드 과정에서 외부 명령 실패를 즉시 드러낸다.
 * @param {string} command - 실행할 명령
 * @param {string[]} args - 명령 인자 목록
 * @param {object} options - spawn 옵션
 * @returns {import("node:child_process").SpawnSyncReturns<string>} 명령 실행 결과
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: false
  });

  if (result.status !== 0) {
    const detail = options.capture ? `${result.stderr || result.stdout || ""}`.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }

  return options.capture ? String(result.stdout || "") : "";
}

/**
 * git 명령 실행 방식을 한곳으로 모은다.
 * @param {string[]} args - git 인자 목록
 * @param {object} options - spawn 옵션
 * @returns {import("node:child_process").SpawnSyncReturns<string>} git 실행 결과
 */
function git(args, options = {}) {
  return run("git", args, options);
}

/**
 * 운영체제별 경로 구분자 차이를 git 경로 기준으로 맞춘다.
 * @param {string} path - 정규화할 경로
 * @returns {string} git 스타일 경로
 */
function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^"|"$/g, "");
}

/**
 * 현재 staged 상태의 파일 목록을 조회한다.
 * @returns {string[]} staged 파일 목록
 */
function stagedFiles() {
  return git(["diff", "--cached", "--name-only"], { capture: true })
    .split(/\r?\n/)
    .map(normalizePath)
    .filter(Boolean);
}

/**
 * 민감 파일이 업로드 대상에 포함되지 않도록 차단한다.
 * @param {string[]} files - staged 파일 목록
 * @returns {void} 반환값 없음
 * @throws {Error} 차단 경로가 staged 상태일 때 발생
 */
function assertSafeStagedFiles(files) {
  const blocked = files.filter(file => blockedPathPatterns.some(pattern => pattern.test(file)));
  if (!blocked.length) return;

  throw new Error(
    [
      "Refusing to commit blocked local/private paths:",
      ...blocked.map(file => `- ${file}`),
      "Update .gitignore or unstage these files before uploading."
    ].join("\n")
  );
}

/**
 * 스크립트가 git 저장소 안에서만 실행되도록 보장한다.
 * @returns {void} 반환값 없음
 * @throws {Error} git 저장소가 아닐 때 발생
 */
function ensureRepository() {
  if (!existsSync(".git")) {
    git(["init"]);
  }

  const remotes = git(["remote"], { capture: true })
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);

  if (!remotes.includes("origin")) {
    git(["remote", "add", "origin", "https://github.com/hy040504/claude-client.git"]);
  }
}

/**
 * 배포 업로드가 main 브랜치에서만 일어나도록 제한한다.
 * @returns {void} 반환값 없음
 * @throws {Error} 현재 브랜치가 main이 아닐 때 발생
 */
function ensureMainBranch() {
  const branch = git(["branch", "--show-current"], { capture: true }).trim();
  if (branch !== "main") {
    git(["branch", "-M", "main"]);
  }
}

/**
 * 커밋할 staged 변경사항이 있는지 확인한다.
 * @returns {boolean} staged 변경 존재 여부
 */
function hasStagedChanges() {
  return stagedFiles().length > 0;
}

/**
 * git 업로드 검증과 커밋, push 흐름을 실행한다.
 * @returns {void} 반환값 없음
 */
function main() {
  ensureRepository();
  ensureMainBranch();

  git(["add", "."]);
  const files = stagedFiles();
  assertSafeStagedFiles(files);

  if (!hasStagedChanges()) {
    console.log("[git-upload] No changes to commit.");
    git(["status", "--short", "--branch"]);
    return;
  }

  console.log(`[git-upload] Committing ${files.length} file(s): ${message}`);
  git(["commit", "-m", message]);
  git(["push", "-u", "origin", "main"]);
  git(["status", "--short", "--branch"]);
}

try {
  main();
} catch (error) {
  console.error(`[git-upload] ${error?.message || error}`);
  process.exitCode = 1;
}
