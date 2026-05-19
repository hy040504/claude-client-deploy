import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAppConfig } from "../config/app-config.js";
import { loadConversationListFromBrowser } from "../browser/conversation-list.js";
import { deleteLastChat, loadLastChat } from "../state/last-chat.js";
import { formatCommandPreview } from "../shared/mask.js";
import { fromProjectRoot } from "../shared/paths.js";

const CLI_STDOUT_MAX_BYTES = 1024 * 1024 * 20;
const DEFAULT_MODEL_CHOICES = [
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-haiku-4-5"
];

/**
 * Claude 채팅을 대화형 프롬프트로 실행한다.
 * @returns {Promise<void>} 프롬프트 종료
 */
export async function runChatPrompt() {
  const config = createAppConfig();
  const rl = createInterface({ input, output });
  const cliPath = fromProjectRoot("index.js");

  try {
    while (true) {
      printMenu();
      const selected = await ask(rl, "선택");

      if (selected === "1") await refreshCookies();
      else if (selected === "2") await startNewChatLoop();
      else if (selected === "3") await continueExistingChatLoop();
      else if (selected === "4") deleteResume();
      else if (selected === "5") await logoutSession();
      else if (selected === "0") return;
      else console.log("없는 메뉴입니다.");
    }
  } finally {
    rl.close();
  }

  /**
   * 브라우저 로그인 또는 Cookie header 입력으로 세션 쿠키를 갱신한다.
   * @returns {Promise<void>} 쿠키 갱신 흐름 완료
   */
  async function refreshCookies() {
    printCookieMenu();
    const selected = await ask(rl, "선택");

    if (selected === "1") {
      console.log("\n[Background Login] 자동 로그인을 시작합니다.");
      console.log("실패 시 안내에 따라 Interactive Login으로 재시도해주세요.");
      await runNodeScript(fromProjectRoot("scripts/background-login.js"));
    } else if (selected === "2") {
      console.log("\n[Interactive Login] 보이는 Chrome 창을 통해 로그인을 시작합니다.");
      await runNodeScript(fromProjectRoot("scripts/interactive-login.js"));
    } else if (selected === "3") {
      const cookieHeader = await ask(rl, "Cookie header");
      if (!cookieHeader) {
        console.log("Cookie header가 비어 있어 취소합니다.");
        return;
      }

      const result = await runCliJson("seed-cookie", [cookieHeader]);
      console.log(`저장된 쿠키 수: ${Array.isArray(result.cookies) ? result.cookies.length : 0}`);
    } else if (selected !== "0") {
      console.log("없는 메뉴입니다.");
    }
  }

  /**
   * 새 채팅을 만들고 이어서 메시지를 주고받는다.
   * @returns {Promise<void>} 새 채팅 흐름 완료
   */
  async function startNewChatLoop() {
    const firstMessage = await ask(rl, "첫 메시지");
    if (!firstMessage) {
      console.log("메시지가 비어 있어 취소합니다.");
      return;
    }

    const model = await chooseModel();
    const args = ["auto", firstMessage, model];
    const result = await runCliJson("chat-new", args);
    printChatResult(result);

    if (!result.conversationId || !result.assistantMessageUuid) {
      console.log("대화 지속에 필요한 값이 없어 이어서 진행할 수 없습니다.");
      return;
    }

    await chatLoop(result.conversationId, result.assistantMessageUuid, model);
  }

  /**
   * 기존 대화를 선택해 이어서 메시지를 주고받는다.
   * @returns {Promise<void>} 기존 채팅 흐름 완료
   */
  async function continueExistingChatLoop() {
    const resume = loadLastChat(config.lastChatPath);
    const selection = await chooseConversation(resume?.conversationId);
    if (!selection) return;

    const conversationId = selection.conversationId;
    const model = await chooseModel();

    const parentMessageUuid = await resolveParentMessageUuid(
      conversationId,
      selection.assistantMessageUuid || resume?.assistantMessageUuid
    );
    if (!parentMessageUuid) {
      console.log("직전 assistant message UUID를 자동으로 찾지 못했습니다.");
      return;
    }

    console.log(`자동 감지 assistantMessageUuid: ${parentMessageUuid}`);
    await chatLoop(conversationId, parentMessageUuid, model);
  }

  /**
   * 사용 가능한 모델 목록을 보여주고 번호로 모델을 선택한다.
   * @returns {Promise<string>} 선택된 Claude 모델
   */
  async function chooseModel() {
    const models = modelChoices(config.defaultModel);
    const defaultIndex = findDefaultModelIndex(models, config.defaultModel);

    printModelChoices(models, config.defaultModel);
    const selected = await askWithDefault(rl, "모델 번호", String(defaultIndex + 1));
    const index = Number.parseInt(selected, 10);

    if (!Number.isInteger(index) || index < 1 || index > models.length) {
      console.log("유효한 번호가 아니어서 기본 모델을 사용합니다.");
      return config.defaultModel;
    }

    return models[index - 1];
  }

  /**
   * 같은 대화에서 parent message UUID를 갱신하며 메시지를 반복 전송한다.
   * @param {string} conversationId - 대화 ID
   * @param {string} initialParentMessageUuid - 시작 parent 메시지 UUID
   * @param {string} model - 사용할 Claude 모델
   * @returns {Promise<void>} 채팅 루프 종료
   */
  async function chatLoop(conversationId, initialParentMessageUuid, model) {
    let parentMessageUuid = initialParentMessageUuid;

    while (true) {
      const message = await ask(rl, "보낼 메시지(/exit 종료)");
      if (message === "/exit") return;
      if (!message) continue;

      const args = ["auto", conversationId, parentMessageUuid, message];
      if (model) args.push(model);

      const result = await runCliJson("chat-send", args);
      printChatResult(result);

      if (result.assistantMessageUuid) parentMessageUuid = result.assistantMessageUuid;
      else console.log("assistant message UUID가 없어 다음 parent를 갱신하지 못했습니다.");
    }
  }

  /**
   * 마지막 채팅 resume 파일을 삭제한다.
   * @returns {void} 반환값 없음
   */
  function deleteResume() {
    if (!deleteLastChat(config.lastChatPath)) {
      console.log("삭제할 resume 파일이 없습니다.");
      return;
    }

    console.log("last-chat.json resume를 삭제했습니다.");
  }

  /**
   * 저장된 Claude 세션 파일과 브라우저 프로필을 삭제한다.
   * @returns {Promise<void>} 로그아웃 완료
   */
  async function logoutSession() {
    const confirmed = await ask(rl, "cookie jar, state, profile을 모두 삭제합니다. 계속할까요? (y/N)");
    if (!/^y(es)?$/i.test(confirmed)) {
      console.log("취소했습니다.");
      return;
    }

    const result = await runCliJson("logout", []);
    console.log(result.message);
  }

  /**
   * 별도 Node.js 스크립트를 현재 프로젝트 루트에서 실행한다.
   * @param {string} scriptPath - 실행할 스크립트 경로
   * @returns {Promise<void>} 스크립트 실행 완료
   */
  async function runNodeScript(scriptPath, envOverrides = {}) {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: fromProjectRoot(),
      env: {
        ...process.env,
        ...envOverrides
      },
      stdio: "inherit",
      shell: false
    });

    await waitForChildProcess(child);
  }

  /**
   * CLI를 실행하면서 stderr 진행 로그는 즉시 보여주고 stdout JSON만 수집한다.
   * @param {string[]} args - Node.js 실행 인자
   * @param {object} options - 실행 옵션
   * @param {string} options.cwd - 작업 디렉터리
   * @param {number} options.maxStdoutBytes - stdout 최대 수집 크기
   * @returns {Promise<string>} CLI stdout
   */
  async function runCliProcess(args, options) {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > options.maxStdoutBytes) {
        child.kill();
        return;
      }
      stdout += chunk;
    });

    child.stderr.on("data", chunk => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => {
        if (stdoutBytes > options.maxStdoutBytes) {
          reject(new Error("CLI stdout이 너무 커서 중단했습니다."));
        } else if (code === 0) {
          resolve();
        } else {
          const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
          reject(new Error(`명령이 실패했습니다. exit code=${code}${detail}`));
        }
      });
    });

    return stdout;
  }

  /**
   * CLI 명령을 실행하고 JSON 출력을 파싱한다.
   * @param {string} command - 실행할 CLI 명령
   * @param {string[]} args - CLI 인자
   * @returns {Promise<object>} 파싱된 JSON 결과
   */
  async function runCliJson(command, args) {
    console.log(`\n> node index.js ${formatCommandPreview(command, args)}`);

    const stdout = await runCliProcess([cliPath, command, ...args], {
      cwd: fromProjectRoot(),
      maxStdoutBytes: CLI_STDOUT_MAX_BYTES
    });

    return parseJsonOutput(stdout);
  }

  /**
   * 이어서 보내기에 필요한 parent assistant message UUID를 결정한다.
   * @param {string} conversationId - 대화 ID
   * @param {string|null} resumeAssistantMessageUuid - 저장된 assistant 메시지 UUID
   * @returns {Promise<string|null>} parent 메시지 UUID 또는 null
   */
  async function resolveParentMessageUuid(conversationId, resumeAssistantMessageUuid) {
    if (resumeAssistantMessageUuid) return resumeAssistantMessageUuid;

    const conversation = await runCliJson("chat-get", ["auto", conversationId]);
    if (isCloudflareBlocked(conversation)) {
      console.log("현재 쿠키 상태로는 대화 조회가 Cloudflare에 막혀 있습니다. 먼저 쿠키를 갱신하세요.");
      return null;
    }
    return findLatestAssistantMessageUuid(conversation?.data);
  }

  /**
   * 이어서 진행할 대화를 API 또는 브라우저 DOM에서 선택한다.
   * @param {string|null} resumeConversationId - 저장된 최근 대화 ID
   * @returns {Promise<object|null>} 선택된 대화 정보 또는 null
   */
  async function chooseConversation(resumeConversationId) {
    const response = await runCliJson("chat-list", ["auto"]);
    let conversations = [];

    if (isCloudflareBlocked(response)) {
      console.log("API 대화 목록 조회가 Cloudflare에 막혀 브라우저에서 직접 목록을 읽습니다.");
      conversations = await loadConversationsFromBrowser(config).catch(error => {
        console.log(error?.message || error);
        return [];
      });
    } else {
      conversations = extractConversationChoices(response?.data);
    }

    if (!conversations.length) {
      console.log("선택할 대화 목록을 찾지 못했습니다. 먼저 쿠키를 갱신해보세요.");
      return null;
    }

    printConversationChoices(conversations, resumeConversationId);
    const selected = await askWithDefault(rl, "대화 번호", findDefaultConversationIndex(conversations, resumeConversationId));
    const index = Number.parseInt(selected, 10);

    if (!Number.isInteger(index) || index < 1 || index > conversations.length) {
      console.log("유효한 번호를 선택해야 합니다.");
      return null;
    }

    return conversations[index - 1];
  }
}

/**
 * 채팅 프롬프트 메인 메뉴를 출력한다.
 * @returns {void} 반환값 없음
 */
function printMenu() {
  console.log("\n=== Claude 쿠키 채팅 프롬프트 ===");
  console.log("1. 쿠키/로그인 갱신");
  console.log("2. 새 채팅 시작");
  console.log("3. 기존 대화 이어서 채팅");
  console.log("4. 마지막 채팅 resume 삭제");
  console.log("5. Claude 세션 완전 로그아웃");
  console.log("0. 종료");
}

/**
 * 쿠키 갱신 방법 선택 메뉴를 출력한다.
 * @returns {void} 반환값 없음
 */
function printCookieMenu() {
  console.log("\n--- 쿠키/로그인 갱신 ---");
  console.log("1. Background Login (안되면 Interactive Login으로 시도할 것)");
  console.log("2. Interactive Login (보이는 Chrome으로 로그인)");
  console.log("3. Cookie header 직접 입력");
  console.log("0. 취소");
}

/**
 * 기본 모델을 포함한 모델 선택 목록을 만든다.
 * @param {string} defaultModel - 설정된 기본 Claude 모델
 * @returns {string[]} 중복 없는 모델 선택지
 */
function modelChoices(defaultModel) {
  const choices = [defaultModel, ...DEFAULT_MODEL_CHOICES].filter(Boolean);
  return [...new Set(choices)];
}

/**
 * 선택 가능한 모델 목록을 출력한다.
 * @param {string[]} models - 모델 선택지
 * @param {string} defaultModel - 설정된 기본 Claude 모델
 * @returns {void} 반환값 없음
 */
function printModelChoices(models, defaultModel) {
  console.log("\n=== 모델 선택 ===");
  console.log(`기본 모델: ${defaultModel}`);

  for (let index = 0; index < models.length; index += 1) {
    const marker = models[index] === defaultModel ? " *기본*" : "";
    console.log(`${index + 1}. ${models[index]}${marker}`);
  }
}

/**
 * 기본 모델의 선택 번호를 찾는다.
 * @param {string[]} models - 모델 선택지
 * @param {string} defaultModel - 설정된 기본 Claude 모델
 * @returns {number} 기본 모델 인덱스
 */
function findDefaultModelIndex(models, defaultModel) {
  const index = models.findIndex(model => model === defaultModel);
  return index >= 0 ? index : 0;
}

/**
 * 사용자 입력을 한 줄 읽고 공백을 정리한다.
 * @param {object} rl - readline 인터페이스
 * @param {string} message - 프롬프트 메시지
 * @returns {Promise<string>} 입력값
 */
async function ask(rl, message) {
  return (await rl.question(`${message}> `)).trim();
}

/**
 * 기본값이 있는 사용자 입력을 읽는다.
 * @param {object} rl - readline 인터페이스
 * @param {string} message - 프롬프트 메시지
 * @param {string} fallback - 입력이 없을 때 사용할 값
 * @returns {Promise<string>} 입력값 또는 기본값
 */
async function askWithDefault(rl, message, fallback) {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = await ask(rl, `${message}${suffix}`);
  return value || fallback || "";
}

/**
 * 하위 프로세스가 정상 종료될 때까지 기다린다.
 * @param {object} child - child_process 인스턴스
 * @returns {Promise<void>} 정상 종료
 * @throws {Error} 프로세스 오류 또는 비정상 종료 시 발생
 */
async function waitForChildProcess(child) {
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`명령이 실패했습니다. exit code=${code}`));
    });
  });
}

/**
 * CLI stdout에서 JSON 객체를 파싱한다.
 * @param {string} stdout - CLI 표준 출력
 * @returns {object} 파싱된 JSON 객체
 * @throws {Error} JSON 출력을 찾지 못할 때 발생
 */
function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) throw new Error("CLI 출력에서 JSON을 찾지 못했습니다.");
  return JSON.parse(trimmed);
}

/**
 * 채팅 응답 핵심 정보를 콘솔에 출력한다.
 * @param {object} result - 채팅 응답 요약
 * @returns {void} 반환값 없음
 */
function printChatResult(result) {
  console.log(`상태: ${result.status}`);
  console.log(`대화 ID: ${result.conversationId || ""}`);
  console.log(`메시지 UUID: ${result.assistantMessageUuid || ""}`);
  console.log("\n어시스턴트:");
  console.log(result.assistantText || "");
}

/**
 * 다양한 Claude 응답 구조에서 대화 선택지 목록을 추출한다.
 * @param {unknown} root - API 응답 루트
 * @returns {object[]} 중복 제거된 대화 선택지 목록
 */
function extractConversationChoices(root) {
  const matches = [];
  visit(root);

  const unique = new Map();
  for (const item of matches) {
    if (!unique.has(item.conversationId)) unique.set(item.conversationId, item);
  }

  return [...unique.values()];

  /**
   * 중첩 응답을 순회하며 대화 후보를 수집한다.
   * @param {unknown} value - 순회할 값
   * @returns {void} 반환값 없음
   */
  function visit(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const candidate = toConversationChoice(value);
    if (candidate) matches.push(candidate);

    for (const nested of Object.values(value)) {
      visit(nested);
    }
  }
}

/**
 * 응답 객체 하나를 대화 선택지로 변환한다.
 * @param {object} value - 후보 응답 객체
 * @returns {object|null} 대화 선택지 또는 null
 */
function toConversationChoice(value) {
  const conversationId =
    value.uuid ||
    value.conversation_uuid ||
    value.conversationId ||
    value.id;

  const title =
    value.name ||
    value.title ||
    value.chat_title ||
    value.display_name;

  if (!isUuidLike(conversationId)) return null;
  return {
    conversationId,
    title: typeof title === "string" && title.trim() ? title.trim() : "(제목 없음)",
    updatedAt: value.updated_at || value.updatedAt || value.created_at || value.createdAt || null,
    assistantMessageUuid: value.current_leaf_message_uuid || value.currentLeafMessageUuid || null
  };
}

/**
 * 선택 가능한 대화 목록을 출력한다.
 * @param {object[]} conversations - 대화 선택지 목록
 * @param {string|null} resumeConversationId - 최근 대화 ID
 * @returns {void} 반환값 없음
 */
function printConversationChoices(conversations, resumeConversationId) {
  console.log("\n=== 대화 목록 ===");

  for (let index = 0; index < conversations.length; index += 1) {
    const item = conversations[index];
    const marker = item.conversationId === resumeConversationId ? " *최근*" : "";
    const dateText = item.updatedAt ? ` [${String(item.updatedAt)}]` : "";
    console.log(`${index + 1}. ${item.title}${dateText}${marker}`);
  }
}

/**
 * 최근 대화가 있으면 기본 선택 번호로 사용한다.
 * @param {object[]} conversations - 대화 선택지 목록
 * @param {string|null} resumeConversationId - 최근 대화 ID
 * @returns {string} 기본 선택 번호
 */
function findDefaultConversationIndex(conversations, resumeConversationId) {
  if (!resumeConversationId) return "1";
  const index = conversations.findIndex(item => item.conversationId === resumeConversationId);
  return index >= 0 ? String(index + 1) : "1";
}

/**
 * 값이 UUID 문자열 형태인지 확인한다.
 * @param {unknown} value - 검사할 값
 * @returns {boolean} UUID 형태 여부
 */
function isUuidLike(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * 응답이 Cloudflare challenge 차단인지 판단한다.
 * @param {object} response - API 응답 요약
 * @returns {boolean} Cloudflare 차단 여부
 */
function isCloudflareBlocked(response) {
  if (response?.status !== 403) return false;
  if (String(response?.server || response?.headers?.server || "").toLowerCase().includes("cloudflare")) return true;
  return typeof response?.data === "string" && response.data.includes("Just a moment");
}

/**
 * 대화 데이터에서 가장 마지막 assistant message UUID를 찾는다.
 * @param {unknown} root - 대화 응답 데이터
 * @returns {string|null} 마지막 assistant 메시지 UUID
 */
function findLatestAssistantMessageUuid(root) {
  const matches = [];
  visit(root);
  return matches.at(-1) || null;

  /**
   * 중첩 대화 데이터를 순회하며 assistant UUID 후보를 수집한다.
   * @param {unknown} value - 순회할 값
   * @returns {void} 반환값 없음
   */
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const candidate = extractAssistantUuid(value);
    if (candidate) matches.push(candidate);

    for (const nested of Object.values(value)) {
      visit(nested);
    }
  }
}

/**
 * 단일 응답 객체에서 assistant message UUID를 추출한다.
 * @param {object} value - 후보 응답 객체
 * @returns {string|null} assistant 메시지 UUID 또는 null
 */
function extractAssistantUuid(value) {
  const role = [
    value.sender,
    value.role,
    value.author,
    value.message_sender,
    value?.message?.sender,
    value?.message?.role
  ]
    .filter(Boolean)
    .map(item => String(item).toLowerCase());

  const isAssistant = role.some(item => item.includes("assistant"));
  if (!isAssistant) return null;

  const uuid = value.uuid || value.message_uuid || value?.message?.uuid;
  return typeof uuid === "string" && uuid ? uuid : null;
}

/**
 * 실제 브라우저 DOM에서 대화 목록을 읽어 선택지 형태로 변환한다.
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object[]>} 대화 선택지 목록
 */
async function loadConversationsFromBrowser(config) {
  const list = await loadConversationListFromBrowser(config);
  return list.map(item => ({
    conversationId: item.conversationId,
    title: item.title || "(제목 없음)",
    updatedAt: item.updatedAt || null
  }));
}
