import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAppConfig } from "../config/app-config.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { loadConversationListFromBrowser } from "../browser/conversation-list.js";
import { runSimpleBrowserLoginCli } from "../browser/login-cli-simple.js";
import { deleteLastChat, loadLastChat } from "../state/last-chat.js";
import { formatCommandPreview } from "../shared/mask.js";
import { fromProjectRoot } from "../shared/paths.js";
import { parseAccountOptions } from "../cli/account-options.js";
import { listAccounts, runAccountCommand } from "../cli/account-commands.js";
import { authorizeGmail } from "../gmail/oauth-flow.js";
import { uniqueModels } from "./conversation-data.js";
import { runTuiSession } from "./session-tui.js";
import { runPlainSession } from "./session-cli.js";

const CLI_STDOUT_MAX_BYTES = 1024 * 1024 * 20;

/**
 * CLI와 TUI가 공유하는 계정·로그인·대화 관리 메뉴를 실행한다
 * @param {string[]} argv - 계정 및 실행 모드를 제어할 CLI 인자
 * @param {object} options - 표시 방식 설정
 * @returns {Promise<void>} 프롬프트 실행 완료
 */
export async function runChatMenu(argv = [], options = {}) {
  const { accountId, args } = parseAccountOptions(argv);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp(options.presentation);
    return;
  }

  let config = createAppConfig({ accountId });
  let rl = createInterface({ input, output });
  const cliPath = fromProjectRoot("index.js");
  let quit = false;

  try {
    if (args.includes("--new")) {
      const model = await chooseModel(rl, config.defaultModel);
      rl.close();
      await launchChatSession({ mode: "new", model });
      return;
    }

    if (args.includes("--resume")) {
      const model = await chooseModel(rl, config.defaultModel);
      rl.close();
      await launchChatSession({ mode: "resume", model });
      return;
    }

    while (!quit) {
      printMenu(config, options.presentation);
      const selected = await ask(rl, "선택");

      if (selected === "1") {
        await refreshCookies();
        continue;
      }

      if (selected === "2") {
        const model = await chooseModel(rl, config.defaultModel);
        rl.close();
        await launchChatSession({ mode: "new", model });
        rl = createInterface({ input, output });
        continue;
      }

      if (selected === "3") {
        const resume = loadLastChat(config.lastChatPath);
        const selection = await chooseConversation(rl, config, resume?.conversationId);
        if (!selection) continue;

        if (selection.listAction === "rename") {
          await renameConversationBySelection(rl, config, selection);
          continue;
        }

        if (selection.listAction === "delete") {
          await deleteConversationBySelection(rl, config, selection);
          continue;
        }

        const model = await chooseModel(rl, config.defaultModel);
        rl.close();
        await launchChatSession({
          mode: "resume",
          model,
          conversationId: selection.conversationId,
          title: selection.title,
          assistantMessageUuid:
            selection.assistantMessageUuid ||
            (resume?.conversationId === selection.conversationId ? resume.assistantMessageUuid : null)
        });
        rl = createInterface({ input, output });
        continue;
      }

      if (selected === "4") {
        deleteResume(config);
        continue;
      }

      if (selected === "5") {
        await deleteConversation(rl, config);
        continue;
      }

      if (selected === "6") {
        await renameConversation(rl, config);
        continue;
      }

      if (selected === "7") {
        await deleteAllConversations(rl, config);
        continue;
      }

      if (selected === "8") {
        await logoutSession(rl);
        continue;
      }

      if (selected === "9") {
        await manageAccounts();
        continue;
      }
      if (selected === "10") {
        try {
          const result = await authorizeGmail(config);
          config = createAppConfig({ accountId: config.accountId });
          console.log(`Gmail 인증 완료: ${result.email}`);
        } catch (error) {
          console.log(`Gmail 인증 실패: ${error.message}`);
        }
        continue;
      }
      if (selected === "0") {
        return;
      }

      console.log("알 수 없는 메뉴입니다.");
    }
  } finally {
    rl?.close();
  }

  /**
   * 확정된 계정 설정을 선택한 채팅 화면에 전달한다.
   * @param {object} sessionOptions - 새 채팅 또는 이어쓰기 정보
   * @returns {Promise<void>} 채팅 화면 종료
   */
  async function launchChatSession(sessionOptions) {
    const launch = options.presentation === "cli" ? runPlainSession : runTuiSession;
    const result = await launch({ ...sessionOptions, config });
    quit = Boolean(result?.quit);
  }

  /**
   * 계정을 추가하거나 전환한 뒤 메뉴의 설정을 새 계정으로 교체한다.
   * @returns {Promise<void>} 계정 관리 완료
   */
  async function manageAccounts() {
    for (const account of listAccounts(config)) {
      console.log(
        `${account.active ? "*" : " "} ${account.id}: ${account.email || "기존 .env 계정"} (${account.mode}, ${account.authenticated ? "인증 설정 있음" : "인증 필요"})`
      );
    }
    const id = await ask(rl, "전환할 계정 ID / + 새 계정 추가 / Enter 취소");
    if (!id) return;
    try {
      let selectedId = id;
      if (id === "+") {
        selectedId = await ask(rl, "새 계정 ID");
        const email = await ask(rl, "Gmail 주소");
        const mode = await askWithDefault(rl, "인증 방식 (direct/relay)", config.gmailAuthMode);
        const claudeEmail = await askWithDefault(rl, "Claude 로그인 주소", email);
        runAccountCommand(config, "account-add", [selectedId, email, mode, claudeEmail]);
      }
      runAccountCommand(config, "account-use", [selectedId]);
      config = createAppConfig({ accountId: selectedId });
      console.log(`현재 계정: ${config.accountId}. Gmail 인증은 10번 메뉴에서 진행하세요.`);
    } catch (error) {
      console.log(`계정 변경 실패: ${error.message}`);
    }
  }

  /**
   * 선택한 계정으로 로그인하거나 수동 쿠키를 저장한다.
   * @returns {Promise<void>} 로그인 처리 완료
   */
  async function refreshCookies() {
    printCookieMenu();
    const selected = await ask(rl, "선택");

    if (selected === "1") {
      console.log("\n[간소화 통합 로그인] 작동이 확인된 단계만 사용해 쿠키를 저장합니다...");
      try {
        await runSimpleBrowserLoginCli(config);
        console.log("간소화 통합 로그인과 쿠키 저장이 완료되었습니다.");
      } catch (error) {
        console.log(`간소화 통합 로그인에 실패했습니다: ${error?.message || error}`);
        console.log("필요하면 기존 로그인 메뉴(2번 또는 3번)를 사용하세요.");
      }
      return;
    }

    if (selected === "2") {
      console.log("\n[기존 백그라운드 로그인] 예전 로그인 경로를 실행합니다...");
      await runNodeScript(fromProjectRoot("scripts/background-login.js"));
      return;
    }

    if (selected === "3") {
      console.log("\n[기존 인터랙티브 로그인] 예전 로그인 경로를 실행합니다...");
      await runNodeScript(fromProjectRoot("scripts/interactive-login.js"));
      return;
    }

    if (selected === "4") {
      const cookieHeader = await ask(rl, "Cookie header");
      if (!cookieHeader) {
        console.log("Cookie header가 비어 있습니다. 취소합니다.");
        return;
      }

      const result = await runCliJson("seed-cookie", [cookieHeader]);
      console.log(`가져온 쿠키 수: ${Array.isArray(result.cookies) ? result.cookies.length : 0}`);
      return;
    }

    if (selected !== "0") {
      console.log("알 수 없는 메뉴입니다.");
    }
  }

  /**
   * 현재 계정의 로컬 Claude 세션 삭제를 확인한다.
   * @param {object} rlInstance - readline 인터페이스
   * @returns {Promise<void>} 로그아웃 처리 완료
   */
  async function logoutSession(rlInstance) {
    const confirmed = await ask(rlInstance, "현재 계정의 cookie jar, state, profile를 삭제할까요? (y/N)");
    if (!/^y(es)?$/i.test(confirmed)) {
      console.log("취소했습니다.");
      return;
    }

    const result = await runCliJson("logout", []);
    console.log(result.message || "로그아웃이 완료되었습니다.");
  }

  /**
   * 선택한 대화의 이름을 변경한다.
   * @param {object} rlInstance - readline 인터페이스
   * @param {object} appConfig - 계정 설정
   * @returns {Promise<void>} 이름 변경 완료
   */
  async function renameConversation(rlInstance, appConfig) {
    const resume = loadLastChat(appConfig.lastChatPath);
    const selection = await chooseConversation(rlInstance, appConfig, resume?.conversationId);
    if (!selection?.conversationId) return;

    if (selection.listAction === "rename") {
      await renameConversationBySelection(rlInstance, appConfig, selection);
      return;
    }

    if (selection.listAction === "delete") {
      await deleteConversationBySelection(rlInstance, appConfig, selection);
      return;
    }

    await renameConversationBySelection(rlInstance, appConfig, selection);
  }

  /**
   * 선택한 대화의 삭제를 확인하고 실행한다.
   * @param {object} rlInstance - readline 인터페이스
   * @param {object} appConfig - 계정 설정
   * @returns {Promise<void>} 삭제 처리 완료
   */
  async function deleteConversation(rlInstance, appConfig) {
    const resume = loadLastChat(appConfig.lastChatPath);
    const selection = await chooseConversation(rlInstance, appConfig, resume?.conversationId);
    if (!selection?.conversationId) return;

    if (selection.listAction === "rename") {
      await renameConversationBySelection(rlInstance, appConfig, selection);
      return;
    }

    await deleteConversationBySelection(rlInstance, appConfig, selection);
  }

  /**
   * 대화 목록에서 선택된 항목의 이름을 바로 변경한다.
   * @param {object} rlInstance - readline 인스턴스
   * @param {object} appConfig - CLI 설정
   * @param {object} selection - 선택된 대화 항목
   * @returns {Promise<void>} 처리 완료
   */
  async function renameConversationBySelection(rlInstance, appConfig, selection) {
    if (!selection?.conversationId) return;

    const currentTitle = selection.title || "제목 없음";
    const newTitle = await askWithDefault(rlInstance, "새 대화 이름", currentTitle);
    if (!newTitle.trim()) {
      console.log("새 이름이 비어 있어 취소합니다.");
      return;
    }

    const result = await runCliJson("chat-rename", ["auto", selection.conversationId, newTitle]);
    console.log(`대화 이름을 변경했습니다: ${result?.data?.name || newTitle}`);
  }

  /**
   * 대화 목록에서 선택된 항목을 바로 삭제한다.
   * @param {object} rlInstance - readline 인스턴스
   * @param {object} appConfig - CLI 설정
   * @param {object} selection - 선택된 대화 항목
   * @returns {Promise<void>} 처리 완료
   */
  async function deleteConversationBySelection(rlInstance, appConfig, selection) {
    if (!selection?.conversationId) return;

    const confirmed = await ask(
      rlInstance,
      `대화 '${selection.title || selection.conversationId}'를 삭제할까요? (y/N)`
    );
    if (!/^y(es)?$/i.test(confirmed)) {
      console.log("취소했습니다.");
      return;
    }

    await runCliJson("chat-delete", ["auto", selection.conversationId]);
    if (loadLastChat(appConfig.lastChatPath)?.conversationId === selection.conversationId)
      deleteLastChat(appConfig.lastChatPath);
    console.log("대화를 삭제했습니다.");
  }

  /**
   * 현재 계정의 대화 세션을 모두 삭제한다.
   * @param {object} rlInstance - readline 인스턴스
   * @param {object} appConfig - CLI 설정
   * @returns {Promise<void>} 전체 삭제 처리 완료
   */
  async function deleteAllConversations(rlInstance, appConfig) {
    const response = await runCliJson("chat-list", ["auto"]);
    const conversations = isCloudflareBlocked(response)
      ? await loadConversationListFromBrowser(appConfig).catch(error => {
          console.log(error?.message || error);
          return [];
        })
      : extractConversationChoices(response?.data);
    if (!conversations.length) {
      console.log("삭제할 대화 세션이 없습니다.");
      return;
    }

    console.log(`삭제 대상 대화 세션: ${conversations.length}개`);
    const confirmed = await ask(rlInstance, "모든 대화 세션을 삭제하려면 DELETE ALL 입력");
    if (confirmed !== "DELETE ALL") {
      console.log("취소했습니다.");
      return;
    }

    let succeeded = 0;
    let failed = 0;
    for (let index = 0; index < conversations.length; index += 1) {
      const item = conversations[index];
      try {
        await runCliJson("chat-delete", ["auto", item.conversationId]);
        succeeded += 1;
        if (loadLastChat(appConfig.lastChatPath)?.conversationId === item.conversationId)
          deleteLastChat(appConfig.lastChatPath);
        console.log(`[${index + 1}/${conversations.length}] 삭제 완료: ${item.title || item.conversationId}`);
      } catch (error) {
        failed += 1;
        console.log(
          `[${index + 1}/${conversations.length}] 삭제 실패: ${item.title || item.conversationId} - ${error?.message || error}`
        );
      }
    }

    console.log(`전체 삭제 완료: 성공 ${succeeded}개, 실패 ${failed}개`);
  }

  /**
   * 현재 계정의 마지막 대화 기억만 지운다.
   * @param {object} appConfig - 계정 설정
   * @returns {void} 반환값 없음
   */
  function deleteResume(appConfig) {
    if (!deleteLastChat(appConfig.lastChatPath)) {
      console.log("저장된 이어쓰기 정보가 없습니다.");
      return;
    }

    console.log("last-chat 이어쓰기 정보를 삭제했습니다.");
  }

  /**
   * 로그인 하위 프로세스에 현재 계정을 고정한다.
   * @param {string} scriptPath - 실행할 파일
   * @param {object} envOverrides - 추가 환경 설정
   * @returns {Promise<void>} 하위 프로세스 종료
   */
  async function runNodeScript(scriptPath, envOverrides = {}) {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: fromProjectRoot(),
      env: {
        ...process.env,
        ...envOverrides,
        CLAUDE_ACCOUNT: config.accountId
      },
      stdio: "inherit",
      shell: false
    });

    await waitForChildProcess(child);
  }

  /**
   * 계정에 고정된 CLI 결과를 크기 제한 내에서 수집한다.
   * @param {string[]} commandArgs - CLI 실행 인자
   * @param {object} options - 작업 경로와 출력 한도
   * @returns {Promise<string>} 표준 출력
   */
  async function runCliProcess(commandArgs, options) {
    const child = spawn(process.execPath, commandArgs, {
      cwd: options.cwd,
      env: { ...process.env, CLAUDE_ACCOUNT: config.accountId },
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
          reject(new Error("CLI stdout가 허용 크기를 초과했습니다."));
        } else if (code === 0) {
          resolve();
        } else {
          const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
          reject(new Error(`명령 실행에 실패했습니다. exit code=${code}${detail}`));
        }
      });
    });

    return stdout;
  }

  /**
   * CLI 명령의 JSON 결과를 공통 처리한다.
   * @param {string} command - 명령 이름
   * @param {string[]} commandArgs - 명령 인자
   * @returns {Promise<object>} 실행 결과
   */
  async function runCliJson(command, commandArgs) {
    console.log(`\n> node index.js ${formatCommandPreview(command, commandArgs)}`);

    const stdoutText = await runCliProcess([cliPath, command, ...commandArgs], {
      cwd: fromProjectRoot(),
      maxStdoutBytes: CLI_STDOUT_MAX_BYTES
    });

    return parseJsonOutput(stdoutText);
  }
}

/**
 * 사용자에게 모델 선택 메뉴를 보여주고 결과를 반환한다
 * @param {object} rl - readline 인터페이스
 * @param {string} defaultModel - 기본 모델 이름
 * @returns {Promise<string>} 선택된 모델 이름
 */
async function chooseModel(rl, defaultModel) {
  const models = uniqueModels(defaultModel);
  const defaultIndex = findDefaultModelIndex(models, defaultModel);

  console.log("\n=== 모델 선택 ===");
  console.log(`기본 모델: ${defaultModel}`);
  for (let index = 0; index < models.length; index += 1) {
    const marker = models[index] === defaultModel ? " (기본값)" : "";
    console.log(`${index + 1}. ${models[index]}${marker}`);
  }

  const selected = await askWithDefault(rl, "모델 번호", String(defaultIndex + 1));
  const index = Number.parseInt(selected, 10);

  if (!Number.isInteger(index) || index < 1 || index > models.length) {
    console.log("잘못된 선택입니다. 기본 모델을 사용합니다.");
    return defaultModel;
  }

  return models[index - 1];
}

/**
 * API, 브라우저 fallback, 최근 대화 순서로 이어쓰기 대상을 선택한다
 * @param {object} rl - readline 인터페이스
 * @param {object} config - 애플리케이션 설정
 * @param {string|null} resumeConversationId - 최근 대화 ID
 * @returns {Promise<object|null>} 선택된 대화 정보 또는 null
 */
async function chooseConversation(rl, config, resumeConversationId) {
  let conversations = [];
  let response = null;
  let apiFailed = false;

  try {
    const runtime = createRuntime({ config });
    response = await runtime.api.listChatConversations(config.orgId || "auto");
    runtime.persistJar();
    runtime.persistState();
  } catch (error) {
    apiFailed = true;
    console.log(`API 대화 목록 조회에 실패했습니다: ${error?.message || error}`);
  }

  if (response && !isCloudflareBlocked(response) && !apiFailed) {
    conversations = extractConversationChoices(response?.data);
  } else {
    if (response && isCloudflareBlocked(response)) {
      console.log("API 대화 목록이 Cloudflare에 막혀 브라우저 DOM에서 불러옵니다...");
    } else if (apiFailed) {
      console.log("브라우저 DOM에서 대화 목록을 다시 불러옵니다...");
    }

    conversations = await loadConversationListFromBrowser(config).catch(error => {
      console.log(`브라우저 대화 목록 조회에도 실패했습니다: ${error?.message || error}`);
      return [];
    });
  }

  if (!conversations.length) {
    const resume = loadLastChat(config.lastChatPath);
    if (resume?.conversationId) {
      conversations = [
        {
          conversationId: resume.conversationId,
          title: resume.title || "(최근 저장된 대화)",
          updatedAt: resume.timestamp || null,
          assistantMessageUuid: resume.assistantMessageUuid || null
        }
      ];
      console.log("저장된 최근 대화를 대신 표시합니다.");
    }
  }

  if (!conversations.length) {
    return askConversationManually(rl, config);
  }

  console.log("\n=== 대화 목록 ===");
  console.log("번호: 이어쓰기 / r번호: 이름 변경 / d번호: 삭제");
  for (let index = 0; index < conversations.length; index += 1) {
    const item = conversations[index];
    const marker = item.conversationId === resumeConversationId ? " (최근)" : "";
    const dateText = item.updatedAt ? ` [${String(item.updatedAt)}]` : "";
    console.log(`${index + 1}. ${item.title}${item.starred ? " ★" : ""}${dateText}${marker}`);
  }

  const selected = await askWithDefault(
    rl,
    "대화 번호",
    findDefaultConversationIndex(conversations, resumeConversationId)
  );
  const action = parseConversationListAction(selected);
  const index = Number.parseInt(action.value, 10);

  if (!Number.isInteger(index) || index < 1 || index > conversations.length) {
    console.log("잘못된 대화 선택입니다. 직접 입력 방식으로 전환합니다.");
    return askConversationManually(rl, config);
  }

  const selection = { ...conversations[index - 1] };
  if (action.type !== "open") {
    selection.listAction = action.type;
  }
  return selection;
}

/**
 * 대화 목록을 복원하지 못했을 때 수동 입력 경로를 제공한다
 * @param {object} rl - readline 인터페이스
 * @param {object} config - 애플리케이션 설정
 * @returns {Promise<object|null>} 사용자가 입력한 대화 정보 또는 null
 */
async function askConversationManually(rl, config) {
  console.log("\n대화 목록을 자동으로 가져오지 못했습니다.");

  const resume = loadLastChat(config.lastChatPath);
  if (resume?.conversationId) {
    console.log("1. 최근 저장 대화 사용");
    console.log("2. conversationId 직접 입력");
    console.log("0. 취소");

    const selected = await ask(rl, "선택");
    if (selected === "1") {
      return {
        conversationId: resume.conversationId,
        title: resume.title || "(최근 저장된 대화)",
        updatedAt: resume.timestamp || null,
        assistantMessageUuid: resume.assistantMessageUuid || null
      };
    }

    if (selected === "0") {
      return null;
    }
  }

  const conversationId = await ask(rl, "conversationId");
  if (!conversationId) {
    console.log("conversationId가 비어 있어 취소합니다.");
    return null;
  }

  if (!isUuidLike(conversationId)) {
    console.log("conversationId 형식이 올바르지 않습니다.");
    return null;
  }

  const assistantMessageUuid = await askWithDefault(
    rl,
    "assistantMessageUuid (비워두면 자동 탐색)",
    resume?.assistantMessageUuid || ""
  );

  const title = await askWithDefault(rl, "대화 제목", resume?.title || "수동 선택 대화");

  return {
    conversationId,
    title: title || "수동 선택 대화",
    updatedAt: null,
    assistantMessageUuid: assistantMessageUuid || null
  };
}

/**
 * 목록 응답 여러 형태에서 대화 선택지 배열만 추출한다
 * @param {unknown} root - 목록 응답 데이터
 * @returns {object[]} 중복 제거된 대화 선택지 배열
 */
function extractConversationChoices(root) {
  const matches = [];
  visit(root);

  const unique = new Map();
  for (const item of matches) {
    if (!unique.has(item.conversationId)) {
      unique.set(item.conversationId, item);
    }
  }

  return [...unique.values()];

  /**
   * 중첩 응답을 순회하며 필요한 대화 정보를 수집한다.
   * @param {unknown} value - 탐색할 응답 값
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
 * 응답 객체 하나를 대화 선택지 형식으로 변환한다
 * @param {object} value - 검사할 응답 객체
 * @returns {object|null} 대화 선택지 또는 null
 */
function toConversationChoice(value) {
  const conversationId = value.uuid || value.conversation_uuid || value.conversationId || value.id;

  const title = value.name || value.title || value.chat_title || value.display_name;

  if (!isUuidLike(conversationId)) return null;

  return {
    conversationId,
    title: typeof title === "string" && title.trim() ? title.trim() : "(제목 없음)",
    updatedAt: value.updated_at || value.updatedAt || value.created_at || value.createdAt || null,
    starred: value.starred === true || value.is_starred === true || value.isStarred === true,
    assistantMessageUuid: value.current_leaf_message_uuid || value.currentLeafMessageUuid || null
  };
}

/**
 * 사용자가 입력한 값이 UUID 형식인지 확인한다
 * @param {unknown} value - 검사할 값
 * @returns {boolean} UUID 형식 여부
 */
function isUuidLike(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * 응답이 Cloudflare challenge로 막힌 상태인지 판별한다
 * @param {object} response - API 응답 요약 객체
 * @returns {boolean} Cloudflare 차단 여부
 */
function isCloudflareBlocked(response) {
  if (response?.status !== 403) return false;
  if (
    String(response?.server || response?.headers?.server || "")
      .toLowerCase()
      .includes("cloudflare")
  )
    return true;
  return typeof response?.data === "string" && response.data.includes("Just a moment");
}

/**
 * 최근 대화가 있으면 그 대화를 기본 선택 번호로 돌려준다
 * @param {object[]} conversations - 선택 가능한 대화 목록
 * @param {string|null} resumeConversationId - 최근 대화 ID
 * @returns {string} 기본 선택 번호
 */
function findDefaultConversationIndex(conversations, resumeConversationId) {
  if (!resumeConversationId) return "1";
  const index = conversations.findIndex(item => item.conversationId === resumeConversationId);
  return index >= 0 ? String(index + 1) : "1";
}

/**
 * 대화 목록 입력에서 실행할 동작을 분리한다.
 * @param {string} value - 사용자가 입력한 목록 선택값
 * @returns {{type: string, value: string}} 동작 종류와 번호
 */
function parseConversationListAction(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/^([rd])\s*(\d+)$/i);

  if (match) {
    return {
      type: match[1].toLowerCase() === "r" ? "rename" : "delete",
      value: match[2]
    };
  }

  return {
    type: "open",
    value: normalized
  };
}

/**
 * 모델 목록에서 기본 모델의 인덱스를 찾는다
 * @param {string[]} models - 선택 가능한 모델 목록
 * @param {string} defaultModel - 기본 모델 이름
 * @returns {number} 기본 모델 인덱스
 */
function findDefaultModelIndex(models, defaultModel) {
  const index = models.findIndex(model => model === defaultModel);
  return index >= 0 ? index : 0;
}

/**
 * CLI stdout에서 JSON 본문만 검증해 파싱한다
 * @param {string} stdoutText - CLI 표준 출력 문자열
 * @returns {object} 파싱된 JSON 객체
 * @throws {Error} JSON 시작 위치를 찾지 못하면 발생
 */
function parseJsonOutput(stdoutText) {
  const trimmed = stdoutText.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error("CLI 명령 결과에서 JSON 출력을 찾지 못했습니다.");
  }
  return JSON.parse(trimmed);
}

/**
 * 프롬프트 메시지를 표시하고 한 줄 입력을 받는다
 * @param {object} rl - readline 인터페이스
 * @param {string} message - 사용자에게 보여줄 프롬프트
 * @returns {Promise<string>} 공백 정리된 입력 문자열
 */
async function ask(rl, message) {
  return (await rl.question(`${message}> `)).trim();
}

/**
 * 기본값이 있는 입력 프롬프트를 표시한다
 * @param {object} rl - readline 인터페이스
 * @param {string} message - 사용자에게 보여줄 프롬프트
 * @param {string} fallback - 입력이 비었을 때 사용할 기본값
 * @returns {Promise<string>} 사용자 입력 또는 기본값
 */
async function askWithDefault(rl, message, fallback) {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = await ask(rl, `${message}${suffix}`);
  return value || fallback || "";
}

/**
 * 하위 프로세스가 종료될 때까지 기다리고 실패 코드를 오류로 바꾼다
 * @param {object} child - child_process 인스턴스
 * @returns {Promise<void>} 프로세스 종료 완료
 * @throws {Error} 프로세스가 0이 아닌 코드로 종료되면 발생
 */
async function waitForChildProcess(child) {
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`명령 실행에 실패했습니다. exit code=${code}`));
    });
  });
}

/**
 * 메인 메뉴를 출력한다
 * @param {object} config - 현재 계정 설정
 * @param {string} presentation - cli 또는 tui
 * @returns {void} 반환값 없음
 */
function printMenu(config, presentation) {
  console.log(`\n=== Claude ${presentation === "cli" ? "CLI" : "TUI"} | 계정: ${config.accountId} ===`);
  console.log("1. 쿠키 갱신 / 로그인");
  console.log("2. 새 채팅 시작");
  console.log("3. 기존 채팅 이어쓰기");
  console.log("4. 저장된 이어쓰기 삭제");
  console.log("5. 채팅 세션 삭제");
  console.log("6. 채팅 이름 변경");
  console.log("7. 채팅 세션 전체 삭제");
  console.log("8. 현재 계정의 Claude 로그아웃");
  console.log("9. 계정 추가 / 전환");
  console.log("10. 현재 계정 Gmail 인증");
  console.log("0. 종료");
}

/**
 * 로그인 및 쿠키 갱신 메뉴를 출력한다
 * @returns {void} 반환값 없음
 */
function printCookieMenu() {
  console.log("\n--- 쿠키 갱신 / 로그인 ---");
  console.log("1. 간소화 통합 로그인 + 쿠키 jar 저장 (권장)");
  console.log("2. 기존 백그라운드 로그인");
  console.log("3. 기존 인터랙티브 로그인");
  console.log("4. Cookie header 직접 입력");
  console.log("0. 취소");
}

/**
 * CLI 사용법을 출력한다
 * @param {string} presentation - cli 또는 tui
 * @returns {void} 반환값 없음
 */
function printHelp(presentation) {
  console.log(`사용법: node chat-${presentation === "cli" ? "cli" : "tui"}.js [--account <id>] [--new|--resume]`);
  console.log("");
  console.log("기본 모드는 기존 메뉴/로그인 흐름을 유지합니다.");
  console.log("9번 메뉴에서 계정을 전환하고 10번 메뉴에서 Gmail을 인증할 수 있습니다.");
}
