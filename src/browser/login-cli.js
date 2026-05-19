import { createAppConfig } from "../config/app-config.js";
import { collectBrowserCookies, printCookieSummary, saveCookiesToJar } from "./login-service.js";
import { shutdownCycleTls } from "../http/cycletls-client.js";

/**
 * 브라우저 로그인 CLI를 실행해 쿠키를 저장한다.
 * @param {object} overrides - 설정 덮어쓰기 옵션
 * @returns {Promise<void>} 로그인 쿠키 저장 완료
 */
export async function runBrowserLoginCli(overrides = {}) {
  const config = { ...createAppConfig(), ...overrides };
  try {
    const cookies = await collectBrowserCookies(config);
    saveCookiesToJar(config, cookies);
    printCookieSummary(cookies);
  } finally {
    await shutdownCycleTls();
  }
}
