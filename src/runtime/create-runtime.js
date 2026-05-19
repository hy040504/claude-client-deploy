import { createAppConfig } from "../config/app-config.js";
import { createHttpClient } from "../http/client.js";
import { createClaudeApi } from "../claude/api.js";
import { loadBrowserState, saveBrowserState } from "../state/browser-state.js";
import { loadJar, saveJar, seedBrowserCookies, seedCapturedCookie } from "../state/cookie-jar.js";
import { saveLastChat } from "../state/last-chat.js";

/**
 * 설정, 상태, 쿠키 jar, Claude API 클라이언트를 하나의 런타임으로 묶는다.
 * @returns {object} CLI에서 사용할 런타임 객체
 */
export function createRuntime() {
  const config = createAppConfig();
  const state = loadBrowserState(config.statePath);
  const jar = loadJar(config.jarPath);

  seedBrowserCookies(jar, config.baseUrl, state);
  seedCapturedCookie(jar, config.baseUrl, process.env.CAPTURED_COOKIE);

  /**
   * 현재 cookie jar를 디스크에 저장한다.
   * @returns {void} 반환값 없음
   */
  const persistJar = () => saveJar(config.jarPath, jar);

  /**
   * 마지막 채팅 상태를 설정된 경로에 저장한다.
   * @param {object} value - 저장할 마지막 채팅 상태
   * @returns {void} 반환값 없음
   */
  const saveCurrentLastChat = value => saveLastChat(config.lastChatPath, value);

  /**
   * 현재 브라우저 식별자 상태를 디스크에 저장한다.
   * @returns {void} 반환값 없음
   */
  const persistState = () => saveBrowserState(config.statePath, state);

  const http = createHttpClient(config, state, jar, persistJar);
  const api = createClaudeApi({
    config,
    state,
    jar,
    http,
    saveLastChat: saveCurrentLastChat
  });

  return {
    config,
    state,
    jar,
    api,
    persistJar,
    persistState
  };
}
