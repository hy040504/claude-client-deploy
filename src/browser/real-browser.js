// src/browser/real-browser.js
import { connect } from "puppeteer-real-browser";
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Stealth Plugin 등록
puppeteer.use(StealthPlugin());

/**
 * Cloudflare와 브라우저 세션 의존 요청을 처리할 실제 Chrome을 연결한다.
 * Stealth Plugin + Random Mouse Movement 적용 버전
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

    console.log(`[browser] Launching ${mode} Chrome with Stealth + Human Behavior...`);

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

        console.log(`[browser] Connected successfully (headless: ${headless}, stealth: enabled)`);
        
        return { browser, page };

    } catch (error) {
        console.error(`[browser] Failed to launch browser: ${error.message}`);
        throw error;
    }
}

/**
 * Stealth Plugin + Random Human Behavior 적용
 */
async function applyStealthEnhancements(page, mode = "background") {
    // 1. Stealth 기본 강화
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        
        if (window.chrome) {
            window.chrome.runtime = window.chrome.runtime || {};
        }

        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );

        // 흔적 제거
        delete window.cdc_ewc_12345;
        delete window.cdc_ewc_54321;
    });

    // 2. Random Mouse Movement (background에서도 실행)
    if (mode === "background" || mode === "interactive") {
        await simulateHumanMouseMovement(page);
    }

    console.log("[stealth] Stealth + Random mouse movement applied");
}

/**
 * 자연스러운 마우스 움직임 시뮬레이션
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
            await new Promise(r => setTimeout(r, 400 + Math.random() * 1400));
        }

        console.log(`[stealth] Completed ${movements} random mouse movements`);
    } catch (e) {
        console.log("[stealth] Mouse simulation skipped (possible headless limitation)");
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

/* ==================== 아래는 기존 함수들 (변경 없음) ==================== */

/**
 * 원본 프로필 잠금을 피하기 위해 임시 프로필 복사본을 만든다.
 * @param {string} profilePath - 원본 브라우저 프로필 경로
 * @returns {string} 복사된 임시 프로필 경로
 */
export function cloneBrowserProfile(profilePath) {
    const target = mkdtempSync(join(tmpdir(), `${basename(profilePath)}-clone-`));

    cpSync(profilePath, target, {
        recursive: true,
        force: true,
        filter: source => {
            const name = basename(source);
            return !isLockedRuntimeFile(name);
        }
    });

    return target;
}

/**
 * 브라우저 종료 후 임시 프로필 복사본을 정리한다.
 * @param {string} path - 삭제할 임시 프로필 경로
 * @returns {void} 반환값 없음
 */
export function removeBrowserProfileClone(path) {
    try {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
        console.error(`[browser] failed to remove profile clone: ${path} (${error.code})`);
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
