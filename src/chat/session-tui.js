import readline from "node:readline";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import chalk from "chalk";
import { createRuntime } from "../runtime/create-runtime.js";
import { loadLastChat } from "../state/last-chat.js";
import {
  extractMessagesFromConversation,
  uniqueModels,
  extractConversationTitle,
  findLatestAssistantMessageUuid
} from "./conversation-data.js";

const SPINNER_FRAMES = ["✦", "✧", "✦", "✶", "✦", "✷"];

const ROLE_STYLES = {
  user: {
    label: "나",
    color: chalk.hex("#8fc5ff")
  },
  assistant: {
    label: "Claude",
    color: chalk.hex("#e8e2d8")
  },
  system: {
    label: "시스템",
    color: chalk.hex("#8bd5ca")
  }
};

/**
 * 새 채팅 또는 이어쓰기 상태로 TUI 세션을 시작한다
 * @param {object} options - 세션 시작 옵션
 * @returns {Promise<object|undefined>} 종료 여부 또는 복원할 대화가 없을 때 undefined
 * @throws {Error} TTY 환경이 아니면 발생
 */
export async function runTuiSession(options) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI 채팅 세션은 TTY 터미널에서만 실행할 수 있습니다.");
  }

  const runtime = options.runtime || createRuntime({ config: options.config });
  const models = uniqueModels(runtime.config.defaultModel);
  const requestedIndex = models.findIndex(model => model === options.model);
  const state = {
    runtime,
    models,
    mode: "chat",
    running: true,
    exitToMenu: false,
    modelIndex: requestedIndex >= 0 ? requestedIndex : 0,
    title: options.title || (options.mode === "resume" ? "이전 채팅" : "새 채팅"),
    conversationId:
      options.conversationId ||
      (options.mode === "resume" ? loadLastChat(runtime.config.lastChatPath)?.conversationId : null),
    parentMessageUuid: options.assistantMessageUuid || null,
    messages: [],
    composer: "",
    status: "Enter 전송  Ctrl+J 줄바꿈  PgUp/PgDn 스크롤  Esc 지우기  /exit 메뉴로",
    busy: false,
    streaming: false,
    error: "",
    scroll: 0,
    viewportRows: 0
  };

  if (options.mode === "new") {
    state.messages.push({
      role: "system",
      text: `새 채팅 준비 완료. 모델: ${currentModel(state.models, state)}`
    });
  } else {
    await hydrateConversation(state);
  }

  if (options.mode === "resume" && !state.conversationId) {
    console.log("이어갈 저장된 대화가 없습니다.");
    return;
  }

  const ui = createTerminalUi(state);
  ui.mount();

  try {
    await ui.loop();
  } finally {
    ui.unmount();
    runtime.persistJar();
    runtime.persistState();
  }
  return { quit: Boolean(state.quit) };
}

/**
 * 터미널 입력과 화면 렌더링을 담당하는 TUI 컨트롤러를 생성한다
 * @param {object} state - 세션 공유 상태 객체
 * @returns {{loop: Function, mount: Function, render: Function, unmount: Function}} TUI 제어 객체
 */
function createTerminalUi(state) {
  readline.emitKeypressEvents(process.stdin);
  const onResize = render;
  let spinnerTimer = null;
  let flushTimer = null;
  let bufferedText = "";
  let suppressReturnUntil = 0;
  let pendingResolve = null;
  const inputQueue = [];

  /**
   * 입력을 기다리는 처리기에 값을 전달하고 대기자가 없으면 큐에 보관한다.
   * @param {object} value - 키 입력이나 붙여넣기 정보
   * @returns {void} 반환값 없음
   */
  const emitInput = value => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(value);
      return;
    }
    inputQueue.push(value);
  };

  /**
   * 연속 입력을 하나로 묶어 전달하고 붙여넣기의 줄바꿈이 전송으로 오인되지 않게 한다.
   * @returns {void} 반환값 없음
   */
  const flushBufferedText = () => {
    if (!bufferedText) return;
    const isPasteLike = bufferedText.length > 1 || bufferedText.includes("\n") || bufferedText.includes("\r");
    if (isPasteLike) suppressReturnUntil = Date.now() + 200;
    emitInput({
      sequence: bufferedText,
      pasted: isPasteLike
    });
    bufferedText = "";
  };

  /**
   * 짧은 간격의 입력이 끝날 때까지 기다려 한글 조합과 붙여넣기를 함께 처리한다.
   * @returns {void} 반환값 없음
   */
  const scheduleBufferedFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBufferedText();
    }, 25);
  };

  /**
   * 일반 입력, 붙여넣기, 조작 키를 구분해 메시지 입력 큐에 전달한다.
   * @param {string} sequence - 터미널에서 들어온 문자열
   * @param {object} key - 키 이름과 보조 키 정보
   * @returns {void} 반환값 없음
   */
  const onKeypress = (sequence, key = {}) => {
    const isSingleReturn = key.name === "return" || sequence === "\r" || sequence === "\n";
    const isPasteBurst = typeof sequence === "string" && sequence.length > 1 && !key.ctrl && !key.meta;
    const containsNewline =
      typeof sequence === "string" && !isSingleReturn && (sequence.includes("\n") || sequence.includes("\r"));

    if (isSingleReturn) {
      if (Date.now() < suppressReturnUntil) {
        return;
      }

      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushBufferedText();
      emitInput({
        sequence: "\r",
        name: "return"
      });
      return;
    }

    if (isPasteBurst || containsNewline) {
      bufferedText += sequence;
      scheduleBufferedFlush();
      return;
    }

    const isPlainText =
      typeof sequence === "string" &&
      sequence.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      key.name !== "return" &&
      key.name !== "backspace" &&
      key.name !== "escape" &&
      key.name !== "pageup" &&
      key.name !== "pagedown" &&
      key.name !== "up" &&
      key.name !== "down";

    if (isPlainText) {
      bufferedText += sequence;
      scheduleBufferedFlush();
      return;
    }

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushBufferedText();
    emitInput({
      sequence,
      ...key
    });
  };

  /**
   * 큐에 쌓인 입력을 먼저 반환하고 없으면 다음 키 입력까지 기다린다.
   * @returns {Promise<object>} 다음에 처리할 입력 정보
   */
  const nextInput = async () => {
    if (inputQueue.length > 0) {
      return inputQueue.shift();
    }

    return await new Promise(resolve => {
      pendingResolve = resolve;
    });
  };

  /**
   * 입력을 차례로 처리하며 TUI 세션을 유지한다.
   * @returns {Promise<void>} 입력 루프 종료
   */
  async function loop() {
    render();

    while (state.running) {
      const key = await nextInput();
      if (!key) continue;

      if (state.busy) {
        if (key.ctrl && key.name === "c") {
          state.exitToMenu = true;
          state.running = false;
        }
        continue;
      }

      await handleChatKey(key);
      render();
    }
  }

  /**
   * 붙여넣기와 제어 키를 구분해 입력 상태를 갱신한다.
   * @param {object} key - 정규화한 키 입력
   * @returns {Promise<void>} 키 입력 처리 완료
   */
  async function handleChatKey(key) {
    if (key.ctrl && key.name === "c") {
      state.exitToMenu = true;
      state.running = false;
      return;
    }

    if (key.ctrl && key.name === "l") {
      state.messages = [];
      state.scroll = 0;
      state.status = "화면에 보이는 메시지 기록을 비웠습니다.";
      return;
    }

    if (key.ctrl && key.name === "j") {
      state.composer += "\n";
      return;
    }

    if (key.name === "pageup") {
      state.scroll += Math.max(1, Math.floor(state.viewportRows * 0.8));
      return;
    }

    if (key.name === "pagedown") {
      state.scroll = Math.max(0, state.scroll - Math.max(1, Math.floor(state.viewportRows * 0.8)));
      return;
    }

    if (key.name === "up" && !state.composer.includes("\n")) {
      state.scroll += 1;
      return;
    }

    if (key.name === "down" && !state.composer.includes("\n")) {
      state.scroll = Math.max(0, state.scroll - 1);
      return;
    }

    if (key.name === "return") {
      await submitComposer();
      return;
    }

    if (key.name === "backspace") {
      state.composer = state.composer.slice(0, -1);
      return;
    }

    if (key.name === "escape") {
      state.composer = "";
      state.status = "입력창을 비웠습니다.";
      return;
    }

    if (typeof key.sequence === "string" && key.sequence.length > 0 && !key.ctrl && !key.meta) {
      state.composer += key.sequence.replace(/\r\n/g, "\n").replace(/\r/g, "");
    }
  }

  /**
   * 작성한 메시지를 전송하고 이어쓰기 상태를 갱신한다.
   * @returns {Promise<void>} 메시지 처리 완료
   */
  async function submitComposer() {
    const content = state.composer.trim();
    if (!content) {
      state.status = "메시지를 먼저 입력하세요.";
      return;
    }

    if (content.startsWith("/")) {
      await runSlashCommand(content);
      state.composer = "";
      return;
    }

    state.messages.push({ role: "user", text: state.composer });
    state.composer = "";
    state.error = "";
    state.busy = true;
    startSpinner();
    state.status = "Claude가 응답을 생성하는 중입니다...";
    render();

    try {
      let result;
      if (state.conversationId && !state.parentMessageUuid) {
        throw new Error("이전 assistant 메시지를 확인하지 못했습니다. 대화를 다시 선택하세요.");
      }
      if (!state.conversationId) {
        result = await state.runtime.api.createChat("auto", content, currentModel(state.models, state));
        state.conversationId = result.conversationId || state.conversationId;
        state.title = summarizeTitle(content);
      } else {
        result = await state.runtime.api.sendChatMessage(
          "auto",
          state.conversationId,
          state.parentMessageUuid,
          content,
          currentModel(state.models, state)
        );
      }

      if (!result.assistantMessageUuid) {
        throw new Error("assistant message uuid를 확인하지 못해 다음 메시지를 이어갈 수 없습니다.");
      }

      state.parentMessageUuid = result.assistantMessageUuid;
      const assistantMessage = { role: "assistant", text: "" };
      state.messages.push(assistantMessage);
      await animateAssistantText(state, assistantMessage, result.assistantText || "(빈 응답)");
      state.status = "Enter 전송  Ctrl+J 줄바꿈  PgUp/PgDn 스크롤  Esc 지우기  /exit 메뉴로";
      state.scroll = 0;
    } catch (error) {
      state.error = error?.message || String(error);
      state.messages.push({
        role: "system",
        text: `요청 실패: ${state.error}`
      });
      state.status = "요청에 실패했습니다.";
    } finally {
      state.busy = false;
      stopSpinner();
    }
  }

  /**
   * 화면 내부 명령으로 채팅 상태를 전환한다.
   * @param {string} content - 슬래시 명령
   * @returns {Promise<void>} 명령 처리 완료
   */
  async function runSlashCommand(content) {
    const [command, ...rest] = content.trim().split(/\s+/);

    if (command === "/exit") {
      state.exitToMenu = true;
      state.running = false;
      return;
    }

    if (command === "/quit") {
      state.running = false;
      state.quit = true;
      return;
    }

    if (command === "/new") {
      state.messages = [];
      state.conversationId = null;
      state.parentMessageUuid = null;
      state.title = "새 채팅";
      state.status = "현재 TUI에서 새 채팅을 시작했습니다.";
      state.messages.push({
        role: "system",
        text: `새 채팅 준비 완료. 모델: ${currentModel(state.models, state)}`
      });
      return;
    }

    if (command === "/model") {
      const requested = rest.join(" ").trim();
      if (!requested) {
        state.messages.push({
          role: "system",
          text: `현재 모델: ${currentModel(state.models, state)}\n사용 가능 모델: ${state.models.join(", ")}`
        });
        state.status = "모델 정보를 표시했습니다.";
        return;
      }

      const index = state.models.findIndex(model => model === requested);
      if (index === -1) {
        state.messages.push({
          role: "system",
          text: `알 수 없는 모델: ${requested}`
        });
        state.status = "모델 변경에 실패했습니다.";
        return;
      }

      state.modelIndex = index;
      state.status = `모델 변경: ${currentModel(state.models, state)}`;
      return;
    }

    if (command === "/resume") {
      const resume = loadLastChat(state.runtime.config.lastChatPath);
      if (!resume?.conversationId) {
        state.messages.push({
          role: "system",
          text: "이어갈 저장된 대화가 없습니다."
        });
        state.status = "이어쓰기에 실패했습니다.";
        return;
      }

      state.conversationId = resume.conversationId;
      state.parentMessageUuid = resume.assistantMessageUuid || null;
      state.title = "이전 채팅";
      await hydrateConversation(state);
      return;
    }

    if (command === "/help") {
      state.messages.push({
        role: "system",
        text: [
          "/exit  메인 메뉴로 돌아가기",
          "/quit  프로그램 종료",
          "/new   현재 TUI를 새 채팅으로 초기화",
          "/resume  마지막 저장 대화 불러오기",
          "/model [name]  모델 확인 또는 변경",
          "/help  도움말 보기"
        ].join("\n")
      });
      state.status = "도움말을 표시했습니다.";
      return;
    }

    state.messages.push({
      role: "system",
      text: `알 수 없는 명령어: ${command}`
    });
    state.status = "알 수 없는 명령어입니다.";
  }

  /**
   * TUI에 필요한 터미널 모드와 이벤트를 설정한다.
   * @returns {void} 반환값 없음
   */
  function mount() {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.on("resize", onResize);
    process.stdin.on("keypress", onKeypress);
  }

  /**
   * 종료 시 입력 모드와 커서를 복원한다.
   * @returns {void} 반환값 없음
   */
  function unmount() {
    stopSpinner();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    bufferedText = "";
    pendingResolve = null;
    inputQueue.length = 0;
    process.stdin.off("keypress", onKeypress);
    process.stdout.off("resize", onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  /**
   * 응답 대기 중 화면을 주기적으로 갱신한다.
   * @returns {void} 반환값 없음
   */
  function startSpinner() {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      if (state.busy) render();
    }, 120);
  }

  /**
   * 세션 종료 뒤 타이머가 남지 않도록 정리한다.
   * @returns {void} 반환값 없음
   */
  function stopSpinner() {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }

  /**
   * 터미널 크기에 맞춰 대화와 입력창을 그린다.
   * @returns {void} 반환값 없음
   */
  function render() {
    const width = Math.max(60, process.stdout.columns || 80);
    const height = Math.max(20, process.stdout.rows || 24);
    const composerLines = wrapComposer(state.composer, width - 4);
    const composerHeight = Math.min(8, Math.max(3, composerLines.length + 2));
    const headerHeight = 3;
    const statusHeight = 2;
    const bodyHeight = Math.max(4, height - headerHeight - composerHeight - statusHeight);
    state.viewportRows = bodyHeight;

    const outputLines = [];
    outputLines.push("\x1b[H\x1b[2J");
    outputLines.push(renderHeader(state, width));
    outputLines.push(renderMessages(width, bodyHeight));
    outputLines.push(renderComposer(state, width, composerHeight, composerLines));
    outputLines.push(renderStatus(state, width));
    process.stdout.write(outputLines.join(""));
  }

  /**
   * 스크롤 위치에 해당하는 대화 줄을 선택한다.
   * @param {number} width - 화면 너비
   * @param {number} bodyHeight - 대화 영역 높이
   * @returns {string} 대화 화면 문자열
   */
  function renderMessages(width, bodyHeight) {
    const lines = flattenMessages(getRenderableMessages(state), width);
    const maxScroll = Math.max(0, lines.length - bodyHeight);
    if (state.scroll > maxScroll) state.scroll = maxScroll;
    const start = Math.max(0, lines.length - bodyHeight - state.scroll);
    const visible = lines.slice(start, start + bodyHeight);
    const padded = [...visible];

    while (padded.length < bodyHeight) padded.push("");
    return `${padded.join("\n")}\n`;
  }

  return {
    loop,
    mount,
    render,
    unmount
  };
}

/**
 * 이어쓰기 대상 대화를 서버에서 불러와 TUI 상태에 반영한다
 * @param {object} state - 세션 공유 상태 객체
 * @returns {Promise<void>} 대화 복원 완료
 */
async function hydrateConversation(state) {
  if (!state.conversationId) return;

  state.busy = true;
  state.error = "";
  state.status = "대화를 불러오는 중입니다...";

  try {
    const response = await state.runtime.api.getChatConversation("auto", state.conversationId);
    state.messages = extractMessagesFromConversation(response?.data);
    state.parentMessageUuid = findLatestAssistantMessageUuid(response?.data) || state.parentMessageUuid || null;
    state.title = extractConversationTitle(response?.data) || state.title;

    if (!state.messages.length) {
      state.messages.push({
        role: "system",
        text: "대화 메타데이터는 불러왔지만 메시지 기록은 복원하지 못했습니다."
      });
    }

    state.status = "Enter 전송  Ctrl+J 줄바꿈  PgUp/PgDn 스크롤  Esc 지우기  /exit 메뉴로";
    state.scroll = 0;
  } catch (error) {
    state.error = error?.message || String(error);
    state.messages.push({
      role: "system",
      text: `대화 불러오기 실패: ${state.error}`
    });
    state.status = "대화를 불러오지 못했습니다.";
  } finally {
    state.busy = false;
  }
}

/**
 * 메시지 목록을 현재 터미널 너비에 맞는 줄 배열로 평탄화한다
 * @param {object[]} messages - 렌더링할 메시지 목록
 * @param {number} width - 현재 터미널 너비
 * @returns {string[]} 줄 단위로 펼친 렌더링 결과
 */
function flattenMessages(messages, width) {
  const lines = [];
  const contentWidth = Math.max(20, width - 4);

  for (const message of messages) {
    const style = ROLE_STYLES[message.role] || ROLE_STYLES.system;
    lines.push(style.color(chalk.bold(style.label)));

    for (const line of renderMessageText(message, contentWidth, style)) {
      lines.push(line);
    }

    lines.push("");
  }

  return lines;
}

/**
 * Markdown에 가까운 응답 요소를 터미널 색상으로 구분한다.
 * @param {object} message - 렌더링할 메시지
 * @param {number} width - 본문 최대 표시 너비
 * @param {object} style - role별 기본 스타일
 * @returns {string[]} 터미널 표시 줄 목록
 */
function renderMessageText(message, width, style) {
  const lines = [];
  let inCodeBlock = false;
  let codeLanguage = "";

  for (const sourceLine of String(message.text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    const fence = sourceLine.match(/^```(\S*)/);
    if (fence) {
      inCodeBlock = !inCodeBlock;
      codeLanguage = inCodeBlock ? fence[1] || "code" : "";
      lines.push(renderCodeFence(codeLanguage, width, inCodeBlock));
      continue;
    }

    if (inCodeBlock) {
      for (const line of wrapCodeLine(sourceLine || " ", Math.max(10, width - 2))) {
        lines.push(`  ${renderCodeLine(line, width - 2, codeLanguage)}`);
      }
      continue;
    }

    for (const line of wrapPlainText(sourceLine, width)) {
      lines.push(renderRichTextLine(line, style));
    }
  }

  return lines;
}

/**
 * 코드 블록 경계선을 언어 힌트와 함께 표시한다.
 * @param {string} language - 코드 블록 언어 이름
 * @param {number} width - 본문 최대 표시 너비
 * @param {boolean} opening - 여는 코드 블록 여부
 * @returns {string} 코드 블록 경계 줄
 */
function renderCodeFence(language, width, opening) {
  const label = opening ? ` ${language || "code"} ` : " end ";
  const line = `${label}${"─".repeat(Math.max(0, width - visualLength(label)))}`;
  return `  ${chalk.hex("#8fb3ff")(line)}`;
}

/**
 * 코드 본문을 어두운 배경과 밝은 글자로 표시한다.
 * @param {string} line - 코드 한 줄
 * @param {number} width - 코드 표시 너비
 * @param {string} language - 코드 블록 언어 이름
 * @returns {string} 스타일이 적용된 코드 줄
 */
function renderCodeLine(line, width, language) {
  const visible = visualLength(line);
  const padded = `${line}${" ".repeat(Math.max(0, width - visible))}`;
  return highlightCodeLine(` ${padded} `, language);
}

/**
 * 코드 한 줄의 주요 토큰에 색을 입힌다.
 * @param {string} line - 코드 한 줄
 * @param {string} language - 코드 블록 언어 이름
 * @returns {string} 토큰 색상이 적용된 코드 줄
 */
function highlightCodeLine(line, language) {
  const languageGroup = normalizeCodeLanguage(language);
  const tokenPattern = codeTokenPattern(languageGroup);
  let output = "";
  let lastIndex = 0;

  for (const match of line.matchAll(tokenPattern)) {
    output += colorCodeSegment(line.slice(lastIndex, match.index), "#d7e1ee");
    output += colorCodeToken(match[0], languageGroup);
    lastIndex = match.index + match[0].length;
  }

  output += colorCodeSegment(line.slice(lastIndex), "#d7e1ee");
  return output;
}

/**
 * 코드 하이라이팅에 사용할 토큰 패턴을 만든다
 * @param {string} language - 정규화된 언어 그룹
 * @returns {RegExp} 코드 토큰 탐색용 정규식
 */
function codeTokenPattern(language) {
  const keywords = [...codeKeywordSet(language)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const keywordPattern = keywords ? `\\b(?:${keywords})\\b` : "(?!)";
  return new RegExp(
    [
      '"(?:\\\\.|[^"\\\\])*"',
      "'(?:\\\\.|[^'\\\\])*'",
      "`(?:\\\\.|[^`\\\\])*`",
      "\\/\\/.*",
      "#.*",
      "\\/\\*.*?\\*\\/",
      "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()",
      keywordPattern,
      "\\b\\d+(?:\\.\\d+)?\\b",
      "[{}()[\\].,;:+\\-*/%=<>!|&?]+"
    ].join("|"),
    "g"
  );
}

/**
 * 코드 언어 별칭을 간단한 그룹으로 정규화한다.
 * @param {string} language - 코드 블록 언어 이름
 * @returns {string} 정규화된 언어 그룹
 */
function normalizeCodeLanguage(language) {
  const value = String(language || "").toLowerCase();
  if (["js", "jsx", "ts", "tsx", "javascript", "typescript"].includes(value)) return "js";
  if (["json", "jsonc"].includes(value)) return "json";
  if (["sh", "bash", "shell", "powershell", "ps1", "cmd"].includes(value)) return "shell";
  if (["py", "python"].includes(value)) return "python";
  return "plain";
}

/**
 * 코드 토큰 종류에 맞는 색상을 반환한다.
 * @param {string} token - 코드 토큰
 * @param {string} language - 정규화된 언어 그룹
 * @returns {string} 색상이 적용된 토큰
 */
function colorCodeToken(token, language) {
  if (/^(\/\/|#|\/\*)/.test(token)) return colorCodeSegment(token, "#728394", { italic: true });
  if (/^["'`]/.test(token)) return colorCodeSegment(token, "#b8e986");
  if (/^\d/.test(token)) return colorCodeSegment(token, "#f6b77a");
  if (/^(true|false|null|undefined|None|True|False)$/.test(token)) return colorCodeSegment(token, "#d6a6ff");
  if (codeKeywordSet(language).has(token)) return colorCodeSegment(token, "#7cc7ff", { bold: true });
  if (/^[A-Za-z_$][\w$]*$/.test(token)) return colorCodeSegment(token, "#8fd3ff");
  if (/^[{}()[\].,;:+\-*/%=<>!|&?]+$/.test(token)) return colorCodeSegment(token, "#8a96a3");
  return colorCodeSegment(token, "#d7e1ee");
}

/**
 * 코드 토큰의 전경색과 배경색을 함께 적용한다
 * @param {string} text - 스타일을 적용할 코드 조각
 * @param {string} color - 전경색 hex 값
 * @param {object} options - 굵기와 기울임 옵션
 * @returns {string} ANSI 스타일이 적용된 코드 조각
 */
function colorCodeSegment(text, color, options = {}) {
  let painter = chalk.bgHex("#171b20").hex(color);
  if (options.bold) painter = painter.bold;
  if (options.italic) painter = painter.italic;
  return painter(text);
}

/**
 * 언어별 키워드 집합을 반환한다
 * @param {string} language - 정규화된 언어 그룹
 * @returns {Set<string>} 하이라이팅할 키워드 집합
 */
function codeKeywordSet(language) {
  const shared = [
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "else",
    "export",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "import",
    "in",
    "let",
    "new",
    "null",
    "return",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "undefined",
    "var",
    "while"
  ];
  const languageKeywords = {
    js: ["async", "await", "extends", "implements", "interface", "private", "public", "static", "type", "yield"],
    json: ["true", "false", "null"],
    python: ["and", "as", "def", "elif", "except", "False", "None", "not", "or", "pass", "print", "True", "with"],
    shell: ["cd", "copy", "del", "do", "done", "echo", "fi", "git", "if", "mkdir", "move", "node", "npm", "rm", "then"]
  };
  return new Set([...shared, ...(languageKeywords[language] || [])]);
}

/**
 * 정규식 조합에 사용할 문자열을 안전하게 이스케이프한다
 * @param {string} value - 이스케이프할 문자열
 * @returns {string} 정규식 리터럴로 사용할 수 있는 문자열
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 일반 텍스트 줄에서 제목, 목록, 인용, 인라인 강조를 구분한다.
 * @param {string} line - 렌더링할 한 줄
 * @param {object} style - role별 기본 스타일
 * @returns {string} 스타일이 적용된 줄
 */
function renderRichTextLine(line, style) {
  if (!line) return "";

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    return chalk.bold.hex("#f3d28b")(`  ${heading[2]}`);
  }

  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return chalk.italic.hex("#b7c4d6")(`  │ ${quote[1]}`);
  }

  const list = line.match(/^(\s*(?:[-*+]|\d+[.]))\s+(.+)$/);
  if (list) {
    return `${chalk.hex("#9bd88f")(`  ${list[1]}`)} ${formatInlineText(list[2], style)}`;
  }

  return `  ${formatInlineText(line, style)}`;
}

/**
 * 인라인 코드와 굵은 강조를 색상으로 구분한다.
 * @param {string} line - 렌더링할 텍스트
 * @param {object} style - role별 기본 스타일
 * @returns {string} 스타일이 적용된 텍스트
 */
function formatInlineText(line, style) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__)/g;
  let output = "";
  let lastIndex = 0;

  for (const match of line.matchAll(pattern)) {
    output += style.color(line.slice(lastIndex, match.index));
    output += formatInlineToken(match[0], style);
    lastIndex = match.index + match[0].length;
  }

  output += style.color(line.slice(lastIndex));
  return output;
}

/**
 * 특수 인라인 토큰 하나를 터미널 스타일로 바꾼다.
 * @param {string} token - Markdown 형태의 인라인 토큰
 * @param {object} style - role별 기본 스타일
 * @returns {string} 스타일이 적용된 토큰
 */
function formatInlineToken(token, style) {
  if (token.startsWith("`") && token.endsWith("`")) {
    return chalk.bgHex("#26313d").hex("#cde4ff")(` ${token.slice(1, -1)} `);
  }

  const text = token.replace(/^(\*\*|__)/, "").replace(/(\*\*|__)$/, "");
  return chalk.bold.hex("#fff1b8")(text || style.color(token));
}

/**
 * 현재 상태를 기준으로 실제 화면에 그릴 메시지 목록을 구성한다
 * @param {object} state - 세션 공유 상태 객체
 * @returns {object[]} 렌더링 대상 메시지 목록
 */
function getRenderableMessages(state) {
  const messages = [...state.messages];

  if (state.busy && !state.streaming) {
    messages.push({
      role: "assistant",
      text: `${SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length]} 응답 생성 중`
    });
  }

  return messages;
}

/**
 * 공백과 개행을 최대한 보존하면서 일반 텍스트를 줄 단위로 감싼다
 * @param {string} text - 줄바꿈할 원본 텍스트
 * @param {number} width - 한 줄 최대 너비
 * @returns {string[]} 줄바꿈된 텍스트 배열
 */
function wrapPlainText(text, width) {
  const lines = [];
  const sourceLines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }

    const words = sourceLine.split(/(\s+)/).filter(Boolean);
    let current = "";

    for (const word of words) {
      const candidate = current + word;
      if (visualLength(candidate) <= width) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current.trimEnd());
        current = "";
      }

      if (visualLength(word) <= width) {
        current = word.trimStart();
        continue;
      }

      let rest = word;
      while (visualLength(rest) > width) {
        const slice = sliceVisual(rest, width);
        lines.push(slice);
        rest = rest.slice(slice.length);
      }
      current = rest;
    }

    lines.push(current.trimEnd());
  }

  return lines;
}

/**
 * 코드 줄의 들여쓰기와 공백을 유지한 채 화면 폭에 맞춰 자른다
 * @param {string} text - 줄바꿈할 코드 문자열
 * @param {number} width - 한 줄의 최대 표시 너비
 * @returns {string[]} 화면 폭에 맞춰 나눈 코드 줄 목록
 */
function wrapCodeLine(text, width) {
  const lines = [];
  let rest = String(text || "").replace(/\t/g, "  ");

  if (!rest) return [""];

  while (visualLength(rest) > width) {
    const slice = sliceVisual(rest, width);
    lines.push(slice);
    rest = [...rest].slice([...slice].length).join("");
  }

  lines.push(rest);
  return lines;
}

/**
 * 현재 계정과 대화 제목이 보이는 헤더를 생성한다
 * @param {object} state - 세션 공유 상태 객체
 * @param {number} width - 현재 터미널 너비
 * @returns {string} 렌더링된 헤더 문자열
 */
function renderHeader(state, width) {
  const title = `${state.title}${state.conversationId ? ` · ${state.conversationId.slice(0, 8)}` : ""}`;
  const left = chalk.bold(`Claude · ${state.runtime.config.accountId}`);
  const right = chalk.dim(currentModel(state.models, state));
  const top = padLine(left, width, right);
  const bottom = padLine(chalk.dim(title), width, state.busy ? chalk.yellow("응답 생성 중...") : chalk.dim("준비됨"));
  return `${top}\n${chalk.dim("─".repeat(width))}\n${bottom}\n`;
}

/**
 * 현재 작업 상태와 오류를 상태줄에 표시한다
 * @param {object} state - 세션 공유 상태 객체
 * @param {number} width - 현재 터미널 너비
 * @returns {string} 렌더링된 상태줄 문자열
 */
function renderStatus(state, width) {
  const error = state.error ? chalk.red(`오류: ${state.error}`) : "";
  const statusText = error || state.status;
  return `${chalk.dim("─".repeat(width))}\n${truncateAnsi(statusText, width)}\n`;
}

/**
 * ANSI 색상 코드를 보존한 채 고정 폭 상태줄을 잘라낸다
 * @param {string} text - 잘라낼 문자열
 * @param {number} width - 최대 표시 너비
 * @returns {string} 잘린 문자열
 */
function truncateAnsi(text, width) {
  const plain = stripAnsi(text);
  if ([...plain].length <= width) return text;
  return `${[...plain].slice(0, Math.max(0, width - 1)).join("")}…`;
}

/**
 * 현재 Claude 스타일 입력창에 맞는 줄 배열을 만든다
 * @param {string} text - 현재 입력창 텍스트
 * @param {number} width - 줄바꿈 기준 너비
 * @returns {string[]} 입력창 줄 배열
 */
function wrapComposer(text, width) {
  if (!text) return [];
  return wrapPlainText(text, Math.max(10, width));
}

/**
 * Claude 스타일 하단 입력 영역 문자열을 생성한다
 * @param {object} state - 세션 공유 상태 객체
 * @param {number} width - 현재 터미널 너비
 * @param {number} composerHeight - 입력창 높이
 * @param {string[]} composerLines - 입력창 줄 배열
 * @returns {string} 렌더링된 입력 영역 문자열
 */
function renderComposer(state, width, composerHeight, composerLines) {
  const lines = [];
  const hint = chalk.dim("Enter 전송  Ctrl+J 줄바꿈  /help 도움말");
  const firstLine = composerLines[0] || chalk.dim("메시지를 입력하세요...");

  lines.push(chalk.dim("─".repeat(width)));
  lines.push(padComposerLine(hint, width));
  lines.push(padComposerLine(`${chalk.dim("›")} ${firstLine}`, width));

  for (const line of composerLines.slice(1, Math.max(1, composerHeight - 1))) {
    lines.push(padComposerLine(`  ${line}`, width));
  }

  while (lines.length < composerHeight + 1) {
    lines.push(" ".repeat(width));
  }

  return `${lines.join("\n")}\n`;
}

/**
 * 입력창 한 줄을 지정 너비만큼 공백으로 채운다
 * @param {string} text - 패딩할 문자열
 * @param {number} width - 최종 너비
 * @returns {string} 패딩이 적용된 문자열
 */
function padComposerLine(text, width) {
  const visible = visualLength(text);
  return `${text}${" ".repeat(Math.max(0, width - visible))}`;
}

/**
 * 실제 스트리밍이 아닐 때도 답변이 점진적으로 보이도록 애니메이션 처리한다
 * @param {object} state - 세션 공유 상태 객체
 * @param {object} message - 갱신할 assistant 메시지 객체
 * @param {string} fullText - 최종 완성 답변 텍스트
 * @returns {Promise<void>} 애니메이션 완료
 */
async function animateAssistantText(state, message, fullText) {
  const source = String(fullText || "");
  state.streaming = true;
  if (!source) {
    message.text = "";
    state.streaming = false;
    return;
  }

  let index = 0;
  while (index < source.length) {
    const step = chooseStreamChunk(source, index);
    message.text += source.slice(index, Math.min(source.length, index + step));
    index += step;
    await delay(streamPauseMs(source, index));
  }
  state.streaming = false;
}

/**
 * 가짜 스트리밍에서 한 번에 추가할 문자 수를 결정한다
 * @param {string} text - 전체 답변 텍스트
 * @param {number} index - 현재 처리 위치
 * @returns {number} 이번 step에서 추가할 문자 수
 */
function chooseStreamChunk(text, index) {
  const char = text[index] || "";
  if (char === "\n") return 1;
  if (/[.!?]/.test(char)) return 1;
  if (/[,\s]/.test(char)) return 1;
  return 2;
}

/**
 * 문장부호 기준으로 스트리밍 간격을 조금 다르게 조정한다
 * @param {string} text - 전체 답변 텍스트
 * @param {number} index - 현재 처리 위치
 * @returns {number} 다음 step 전 대기 시간(ms)
 */
function streamPauseMs(text, index) {
  const previous = text[index - 1] || "";
  if (previous === "\n") return 50;
  if (/[.!?]/.test(previous)) return 70;
  if (previous === ",") return 40;
  return 10;
}

/**
 * ANSI 코드 제외 기준의 화면 표시 길이를 계산한다
 * @param {string} text - 길이를 계산할 문자열
 * @returns {number} 화면 표시 기준 길이
 */
function visualLength(text) {
  return [...stripAnsi(text)].length;
}

/**
 * 화면 표시 폭 기준으로 문자열을 잘라낸다
 * @param {string} text - 잘라낼 문자열
 * @param {number} width - 최대 표시 폭
 * @returns {string} 잘린 문자열
 */
function sliceVisual(text, width) {
  return [...text].slice(0, width).join("");
}

/**
 * 좌우 문자열을 같은 줄에 배치하고 가운데 공백을 채운다
 * @param {string} left - 왼쪽 문자열
 * @param {number} width - 전체 줄 너비
 * @param {string} right - 오른쪽 문자열
 * @returns {string} 정렬된 한 줄 문자열
 */
function padLine(left, width, right = "") {
  const leftWidth = visualLength(left);
  const rightWidth = visualLength(right);
  const spaces = Math.max(1, width - leftWidth - rightWidth);
  return `${left}${" ".repeat(spaces)}${right}`;
}

/**
 * 화면 길이 계산을 위해 ANSI 색상 코드를 제거한다
 * @param {string} text - 처리할 문자열
 * @returns {string} ANSI 코드가 제거된 문자열
 */
function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "");
}

/**
 * 긴 첫 메시지에서 목록 표시용 짧은 제목을 만든다
 * @param {string} text - 제목 후보가 되는 원본 텍스트
 * @returns {string} 요약된 제목 문자열
 */
function summarizeTitle(text) {
  const firstLine =
    String(text || "")
      .trim()
      .split(/\r?\n/)[0] || "새 채팅";
  return [...firstLine].slice(0, 48).join("");
}

/**
 * 현재 세션에서 선택된 모델 이름을 반환한다
 * @param {string[]} models - 선택 가능한 모델 목록
 * @param {object} state - 세션 공유 상태 객체
 * @returns {string|undefined} 현재 선택된 모델 이름
 */
function currentModel(models, state) {
  return models[state.modelIndex] || models[0];
}
