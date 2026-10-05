import { parseAccountOptions } from "./account-options.js";
import { createAppConfig } from "../config/app-config.js";
import { runBrowserLoginCli } from "../browser/login-cli.js";

/**
 * 두 로그인 스크립트가 계정 선택, 오류 출력, 종료 코드를 동일하게 처리하도록 묶는다.
 * @param {string} mode - background 또는 interactive 브라우저 실행 모드
 * @param {string[]} [argv] - 계정 옵션을 포함한 명령행 인자
 * @param {object} [dependencies={}] - 테스트에서 대신 사용할 설정 생성 및 로그인 함수
 * @returns {Promise<void>} 로그인 또는 도움말 출력 완료
 */
export async function runLoginEntry(mode, argv = process.argv.slice(2), dependencies = {}) {
  const buildConfig = dependencies.createConfig || createAppConfig;
  const login = dependencies.login || runBrowserLoginCli;
  try {
    if (!["background", "interactive"].includes(mode)) throw new Error(`지원하지 않는 로그인 모드: ${mode}`);
    const options = parseAccountOptions(argv);
    if (options.args.length === 1 && ["--help", "-h"].includes(options.args[0])) {
      console.log(`사용법: node scripts/${mode}-login.js [--account <계정 ID>]`);
      console.log(
        mode === "background"
          ? "백그라운드 로그인 실패 시 화면을 표시하는 모드로 다시 시도합니다."
          : "사용자가 인증 화면을 확인할 수 있는 로그인 모드입니다."
      );
      return;
    }
    if (options.args.length) throw new Error(`알 수 없는 로그인 인자: ${options.args.join(" ")}`);
    const config = buildConfig(options);
    await login({ ...config, browserLoginMode: mode, browserInteractiveHeadless: false });
  } catch (error) {
    console.error(`[login] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
