import { connect } from "puppeteer-real-browser";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const profileClones = new Set();

/**
 * 계정에 지정된 Chrome 프로필과 실행 모드로 브라우저에 연결한다.
 * @param {object} config - Chrome 경로와 실행 설정
 * @param {object} options - 프로필 경로와 표시 방식 등 이번 실행의 옵션
 * @returns {Promise<object>} 연결된 브라우저와 페이지
 * @throws {Error} Chrome 실행이나 페이지 초기화에 실패한 경우
 */
export async function connectRealBrowser(config, options = {}) {
  await delay(1000); // 안정성을 위한 짧은 대기

  const userDataDir = options.userDataDir;
  if (userDataDir) {
    mkdirSync(userDataDir, { recursive: true });
  }

  const mode = options.mode || "interactive";
  const headless =
    options.headless ??
    (mode === "background" ? config.browserBackgroundHeadless : config.browserInteractiveHeadless) ??
    false;

  console.log(`[browser] ${mode} 모드로 Chrome을 시작합니다.`);

  try {
    const { browser, page } = await connect({
      headless,
      turnstile: true,
      args: buildBrowserArgs(config, mode),
      customConfig: {
        userDataDir,
        chromePath: config.chromeExecutablePath || undefined
      },
      connectOption: {
        defaultViewport: null
      },
      disableXvfb: config.browserDisableXvfb,
      ignoreAllFlags: false
    });

    // Stealth + Human-like Behavior 적용
    await applyStealthEnhancements(page, mode);

    console.log(`[browser] Chrome 연결 완료. headless=${headless}`);

    return { browser, page };
  } catch (error) {
    console.error(`[browser] Chrome 실행 실패: ${error.message}`);
    throw error;
  }
}

/**
 * 기존 로그인 흐름이 사용하는 페이지 초기 설정과 마우스 처리를 적용한다.
 * @param {object} page - 초기화할 브라우저 페이지
 * @param {string} mode - 브라우저 실행 모드
 * @returns {Promise<void>} 페이지 초기화 완료
 */
async function applyStealthEnhancements(page, mode = "background") {
  // 1. Stealth 기본 강화
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { value: undefined });

    if (window.chrome) {
      window.chrome.runtime = window.chrome.runtime || {};
    }

    const originalQuery = window.navigator.permissions.query;
    /**
     * 알림 권한 조회는 현재 상태를 반환하고 다른 권한은 원래 브라우저 조회로 넘긴다.
     * @param {object} parameters - 조회할 권한 이름
     * @returns {Promise<object>} 브라우저 권한 상태
     */
    window.navigator.permissions.query = parameters =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    // 흔적 제거
    delete window.cdc_ewc_12345;
    delete window.cdc_ewc_54321;
  });

  // 2. Random Mouse Movement (background에서도 실행)
  if (mode === "background" || mode === "interactive") {
    await simulateHumanMouseMovement(page);
  }

  console.log("[stealth] 페이지 초기 설정과 마우스 처리를 적용했습니다.");
}

/**
 * 기존 브라우저 초기화에서 사용하는 마우스 이동을 실행한다.
 * @param {object} page - 마우스를 이동할 페이지
 * @returns {Promise<void>} 이동 시도 완료
 */
async function simulateHumanMouseMovement(page) {
  try {
    const width = 1280;
    const height = 900;

    let x = 300 + Math.random() * 500;
    let y = 200 + Math.random() * 400;

    await page.mouse.move(x, y, { steps: 6 });

    const movements = 3 + Math.floor(Math.random() * 4); // 3~6회 움직임

    for (let i = 0; i < movements; i++) {
      x = Math.max(80, Math.min(width - 80, x + (Math.random() * 360 - 180)));
      y = Math.max(80, Math.min(height - 80, y + (Math.random() * 280 - 140)));

      await page.mouse.move(x, y, {
        steps: 10 + Math.floor(Math.random() * 15)
      });

      // 불규칙한 대기 시간 (0.4 ~ 1.8초)
      await delay(400 + Math.random() * 1400);
    }

    console.log(`[stealth] 초기 마우스 이동 ${movements}회를 완료했습니다.`);
  } catch (e) {
    console.log("[stealth] 이 실행 환경에서는 초기 마우스 이동을 생략합니다.");
  }
}

/**
 * 실행 환경과 모드에 맞는 Chrome 인자를 구성한다.
 * @param {object} config - 애플리케이션 설정
 * @param {string} mode - 브라우저 실행 모드
 * @returns {string[]} Chrome 실행 인자 목록
 */
function buildBrowserArgs(config, mode) {
  const args = ["--start-maximized"];

  if (config.browserNoSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  if (mode === "background") {
    args.push(...(config.browserBackgroundArgs || []));
  }

  args.push(...(config.browserExtraArgs || []));

  return [...new Set(args.filter(Boolean))];
}

/**
 * 원본 프로필 잠금을 피하기 위해 임시 프로필 복사본을 만든다.
 * @param {string} profilePath - 원본 브라우저 프로필 경로
 * @returns {string} 복사된 임시 프로필 경로
 */
export function cloneBrowserProfile(profilePath) {
  const target = mkdtempSync(join(tmpdir(), `${basename(profilePath)}-clone-`));
  profileClones.add(resolve(target));
  try {
    cpSync(profilePath, target, {
      recursive: true,
      force: true,
      /**
       * Chrome이 잠근 파일을 제외하고 임시 프로필에 복사할 항목을 고른다.
       * @param {string} source - 복사할 원본 경로
       * @returns {boolean} 복사할 항목인지 여부
       */
      filter: source => {
        const name = basename(source);
        return !isLockedRuntimeFile(name);
      }
    });

    return target;
  } catch (error) {
    removeBrowserProfileClone(target);
    throw error;
  }
}

/**
 * 브라우저 종료 후 임시 프로필 복사본을 정리한다.
 * @param {string} path - 삭제할 임시 프로필 경로
 * @returns {void} 반환값 없음
 * @throws {Error} 이 프로세스에서 만든 임시 복사본이 아닌 경로를 받은 경우
 */
export function removeBrowserProfileClone(path) {
  if (!path) return;
  const target = resolve(path);
  if (!profileClones.has(target) || dirname(target) !== resolve(tmpdir())) {
    throw new Error("현재 프로세스에서 만든 임시 브라우저 프로필만 삭제할 수 있습니다.");
  }
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    profileClones.delete(target);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
    console.error(`[browser] 임시 프로필 정리 실패: ${path} (${error.code})`);
  }
}

/**
 * Chrome 실행 중 잠기거나 복사 가치가 낮은 런타임 파일을 제외한다.
 * @param {string} name - 파일 이름
 * @returns {boolean} 제외 대상 여부
 */
function isLockedRuntimeFile(name) {
  return (
    name === "DevToolsActivePort" ||
    name === "LOCK" ||
    name === "Sessions" ||
    name.includes("Cookies") ||
    name.startsWith("Session_") ||
    name.startsWith("Tabs_") ||
    name.startsWith("Singleton") ||
    name.endsWith(".lock")
  );
}
