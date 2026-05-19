import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatCommandPreview } from "../shared/mask.js";
import { fromProjectRoot } from "../shared/paths.js";

const menuItems = [
  { key: "1", label: "Cookie header 주입", command: "seed-cookie", prompts: [{ message: "Cookie header" }] },
  { key: "2", label: "저장된 쿠키 확인", command: "cookies", prompts: [] },
  { key: "3", label: "계정 프로필 조회", command: "profile", prompts: [] },
  { key: "4", label: "bootstrap 권한 조회", command: "bootstrap", fixedArgs: ["auto"], prompts: [] },
  {
    key: "5",
    label: "새 채팅 생성 및 첫 메시지 전송",
    command: "chat-new",
    fixedArgs: ["auto"],
    prompts: [
      { message: "보낼 메시지" },
      { message: "모델(기본값 사용 시 Enter)", optional: true }
    ]
  },
  {
    key: "6",
    label: "기존 채팅에 메시지 전송",
    command: "chat-send",
    fixedArgs: ["auto"],
    prompts: [
      { message: "conversation ID" },
      { message: "직전 assistant message UUID" },
      { message: "보낼 메시지" },
      { message: "모델(기본값 사용 시 Enter)", optional: true }
    ]
  },
  {
    key: "7",
    label: "채팅 조회",
    command: "chat-get",
    fixedArgs: ["auto"],
    prompts: [{ message: "conversation ID" }]
  },
  {
    key: "8",
    label: "채팅 제목 생성",
    command: "chat-title",
    fixedArgs: ["auto"],
    prompts: [
      { message: "conversation ID" },
      { message: "제목 생성 메시지" }
    ]
  },
  { key: "9", label: "Claude 세션 완전 로그아웃", command: "logout", prompts: [] },
  { key: "0", label: "종료", command: null, prompts: [] }
];

/**
 * 일반 Claude CLI 명령을 대화형 메뉴로 실행한다.
 * @returns {Promise<void>} 프롬프트 종료
 */
export async function runClientPrompt() {
  const rl = createInterface({ input, output });
  const cliPath = fromProjectRoot("index.js");

  try {
    while (true) {
      printMenu();
      const selectedKey = await ask(rl, "선택");
      const item = menuItems.find(menuItem => menuItem.key === selectedKey);

      if (!item) {
        console.log("해당 번호의 메뉴가 없습니다.");
        continue;
      }

      if (!item.command) {
        console.log("종료합니다.");
        return;
      }

      if (item.command === "logout") {
        const confirmed = await ask(rl, "cookie jar, state, profile을 모두 삭제합니다. 계속할까요? (y/N)");
        if (!/^y(es)?$/i.test(confirmed)) {
          console.log("취소했습니다.");
          continue;
        }
      }

      const args = await collectArgs(rl, item);
      if (!args) continue;

      await runClientCommand(cliPath, item.command, args);
      await ask(rl, "계속하려면 Enter");
    }
  } finally {
    rl.close();
  }
}

/**
 * 대화형 CLI 메뉴를 출력한다.
 * @returns {void} 반환값 없음
 */
function printMenu() {
  console.log("\n=== client2 쿠키 기반 CLI ===");
  console.log("로그인은 별도 브라우저에서 처리하고, 이후 요청은 CLI 명령으로 실행합니다.");
  console.log("Cloudflare 403이 발생하면 브라우저 fallback이 자동으로 동작할 수 있습니다.");
  for (const item of menuItems) console.log(`${item.key}. ${item.label}`);
}

/**
 * 선택된 메뉴에 필요한 CLI 인자를 사용자에게 입력받는다.
 * @param {object} rl - readline 인터페이스
 * @param {object} item - 선택된 메뉴 항목
 * @returns {Promise<string[]|null>} 수집된 인자 또는 취소 시 null
 */
async function collectArgs(rl, item) {
  const args = [...(item.fixedArgs || [])];

  for (const prompt of item.prompts) {
    const value = await ask(rl, prompt.message);
    if (!value && !prompt.optional) {
      console.log("필수값이 비어 있어 요청을 취소합니다.");
      return null;
    }
    if (value) args.push(value);
  }

  return args;
}

/**
 * 현재 Node 프로세스로 CLI 명령을 실행한다.
 * @param {string} cliPath - CLI 진입 파일 경로
 * @param {string} command - 실행할 명령
 * @param {string[]} args - 명령 인자
 * @returns {Promise<void>} 명령 실행 완료
 * @throws {Error} 하위 프로세스 실행 실패 시 발생
 */
async function runClientCommand(cliPath, command, args) {
  console.log(`\n> node index.js ${formatCommandPreview(command, args)}`);

  const child = spawn(process.execPath, [cliPath, command, ...args], {
    cwd: fromProjectRoot(),
    stdio: "inherit",
    shell: false
  });

  const result = await Promise.race([once(child, "error"), once(child, "close")]);
  const [value] = result;

  if (value instanceof Error) throw value;
  if (value !== 0) throw new Error(`명령이 실패했습니다. exit code=${value}`);
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
