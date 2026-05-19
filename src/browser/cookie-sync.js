/**
 * tough-cookie jar의 쿠키를 Puppeteer가 받는 형식으로 변환한다.
 * @param {object} jar - tough-cookie cookie jar
 * @param {string} baseUrl - Claude 기준 URL
 * @returns {Promise<object[]>} Puppeteer setCookie payload
 */
export async function jarCookiesToPuppeteerPayload(jar, baseUrl) {
  const originalCookies = await jar.getCookies(baseUrl);

  return originalCookies.map(cookie => ({
    name: cookie.key,
    value: cookie.value,
    domain: cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires: cookie.expires === "Infinity" ? undefined : Math.floor(new Date(cookie.expires).getTime() / 1000)
  }));
}

/**
 * 저장된 cookie jar를 열린 브라우저 페이지에 주입한다.
 * @param {object} page - Puppeteer page 객체
 * @param {string} baseUrl - Claude 기준 URL
 * @param {object} jar - tough-cookie cookie jar
 * @returns {Promise<void>} 쿠키 주입 완료
 */
export async function applyJarCookies(page, baseUrl, jar) {
  const payload = await jarCookiesToPuppeteerPayload(jar, baseUrl);
  if (payload.length) await page.setCookie(...payload);
}

/**
 * Puppeteer cookie 객체를 Set-Cookie 문자열로 변환한다.
 * @param {object} cookie - Puppeteer cookie 객체
 * @returns {string} Set-Cookie 문자열
 */
export function toSetCookieLine(cookie) {
  const parts = [
    `${cookie.name}=${cookie.value}`,
    `Domain=${cookie.domain.replace(/^\./, "")}`,
    `Path=${cookie.path || "/"}`
  ];

  if (cookie.expires && cookie.expires > 0) parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.secure) parts.push("Secure");
  if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);

  return parts.join("; ");
}

/**
 * 브라우저 페이지의 최신 쿠키를 cookie jar에 반영한다.
 * @param {object} page - Puppeteer page 객체
 * @param {object} config - 애플리케이션 설정
 * @param {object} jar - tough-cookie cookie jar
 * @returns {Promise<void>} 쿠키 반영 완료
 */
export async function persistPageCookiesToJar(page, config, jar) {
  const cookies = await page.cookies(config.baseUrl);

  for (const cookie of cookies) {
    jar.setCookieSync(toSetCookieLine(cookie), config.baseUrl, { ignoreError: true });
  }
}
