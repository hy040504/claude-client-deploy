import { loadJar } from "../state/cookie-jar.js";
import { cloneBrowserProfile, connectRealBrowser, removeBrowserProfileClone } from "./real-browser.js";
import { applyJarCookies } from "./cookie-sync.js";
import { resolveBrowserMode } from "./session-manager.js";

/**
 * API 목록 조회가 막힐 때 실제 브라우저 DOM에서 대화 목록을 읽는다.
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object[]>} 브라우저에서 읽은 대화 목록
 */
export async function loadConversationListFromBrowser(config) {
  const profileClonePath = cloneBrowserProfile(config.profilePath);
  const jar = loadJar(config.jarPath);
  const { browser, page } = await connectRealBrowser(config, {
    userDataDir: profileClonePath,
    mode: resolveBrowserMode(config, "fallback", "background")
  });

  try {
    await applyJarCookies(page, config.baseUrl, jar);
    await page.goto(`${config.baseUrl}/new`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(
      () => document.querySelectorAll('a[href^="/chat/"]').length > 0,
      { timeout: 30000 }
    );

    return await page.evaluate(() => {
      const items = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href^="/chat/"]');

      for (const link of links) {
        const href = link.getAttribute("href") || "";
        const match = href.match(/\/chat\/([0-9a-f-]{36})/i);
        const title = (link.textContent || "").trim();

        if (!match || !title) continue;
        if (seen.has(match[1])) continue;
        seen.add(match[1]);

        items.push({
          conversationId: match[1],
          title
        });
      }

      return items;
    });
  } finally {
    await browser.close().catch(() => {});
    removeBrowserProfileClone(profileClonePath);
  }
}
