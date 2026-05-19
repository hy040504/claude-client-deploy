import { existsSync, rmSync } from "node:fs";
import chalk from "chalk";

/**
 * 로컬에 저장된 Claude 세션 관련 파일과 브라우저 프로필을 삭제한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {object} 삭제 결과 요약
 */
export function logoutClaudeSession(config) {
  const targets = [
    { key: "cookieJar", path: config.jarPath, type: "file", label: "Cookie Jar" },
    { key: "state", path: config.statePath, type: "file", label: "Browser State" },
    { key: "lastChat", path: config.lastChatPath, type: "file", label: "Last Chat" },
    { key: "latestClaudeCode", path: config.latestClaudeCodePath, type: "file", label: "Verification Code" },
    { key: "profile", path: config.profilePath, type: "directory", label: "Browser Profile" }
  ];

  const cleared = [];
  const failed = [];
  const missing = [];

  // JSON 파싱을 방해하지 않도록 정보성 로그는 stderr로 출력한다.
  const log = (msg) => process.stderr.write(msg + "\n");

  log(chalk.cyan("\n[logout] Claude 세션 데이터 정리 중..."));

  for (const target of targets) {
    if (!existsSync(target.path)) {
      missing.push(target);
      continue;
    }

    try {
      rmSync(target.path, {
        recursive: target.type === "directory",
        force: true,
        maxRetries: 3,
        retryDelay: 500
      });
      log(chalk.green(`[logout] ✅ 삭제 성공: ${target.label}`));
      cleared.push(target);
    } catch (error) {
      log(chalk.yellow(`[logout] ⚠️ 삭제 실패 (${target.label}): ${error.message}`));
      failed.push({ ...target, error: error.message });
    }
  }

  if (failed.length > 0) {
    log(chalk.red.bold("\n[logout] ❌ 일부 파일을 자동으로 삭제할 수 없습니다."));
    log(chalk.red("브라우저 프로세스가 해당 파일을 사용 중일 가능성이 높습니다."));
    log(chalk.yellow("다음 단계를 진행해 주세요:"));
    log(chalk.yellow("1. 실행 중인 모든 크롬(Chrome/Chromium) 브라우저를 종료하세요."));
    log(chalk.yellow("2. 로그아웃을 다시 시도하거나, 아래 경로를 직접 삭제해 주세요:"));
    failed.forEach(f => log(chalk.gray(`   - ${f.path}`)));
    log("");
  } else {
    log(chalk.green.bold("\n[logout] 🎉 모든 세션 데이터가 성공적으로 삭제되었습니다.\n"));
  }

  return {
    ok: failed.length === 0,
    message: failed.length === 0 
      ? "Claude 세션 데이터가 정리되었습니다. 다른 계정으로 로그인하려면 `npm run browser-login`을 실행하세요."
      : "일부 세션 데이터를 삭제하지 못했습니다. 로그의 안내에 따라 수동 정리를 진행해 주세요.",
    cleared: cleared.map(target => ({ key: target.key, path: target.path })),
    failed: failed.map(target => ({ key: target.key, path: target.path, error: target.error })),
    missing: missing.map(target => ({ key: target.key, path: target.path }))
  };
}
