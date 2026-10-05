# claude-client-deploy

`claude-client`를 기반으로 만든 비공식 Claude.ai CLI입니다. 여러 Gmail 계정의 인증 정보와 Claude 세션을 분리하고, Gmail 조회를 나중에 별도 서버로 옮길 수 있도록 직접 연결과 relay 연결을 지원합니다.

Claude.ai 웹 세션을 사용하며 공식 Anthropic SDK가 아닙니다. 웹 API 및 브라우저 로그인 동작이 바뀌면 추가 대응이 필요합니다.

## 시작하기

Node.js 20 이상, Chrome 또는 Chromium이 필요합니다.

```bash
npm ci
```

`.env.example`을 `.env`로 복사합니다. 직접 Gmail 연결은 `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`을 설정합니다. 원격 연결은 `GMAIL_RELAY_SERVER_URL`과 서버가 요구하는 경우 `GMAIL_RELAY_API_KEY`를 설정합니다.

```bash
node index.js account-add personal personal@gmail.com direct
node index.js --account personal gmail-auth
node index.js account-use personal
npm run chat:tui
```

처음 Gmail 인증 시 출력된 URL에서 해당 Google 계정으로 동의합니다. 계정당 최초 한 번 인증한 뒤 저장된 자격 증명을 재사용합니다. 채팅 메뉴의 **1번**에서 Claude에 로그인하고, **2번**에서 대화를 시작합니다. Google 동의가 취소되거나 토큰이 만료·철회되면 다시 Gmail 인증이 필요합니다.

## 실행 파일

| 실행                                     | 역할                                      |
| ---------------------------------------- | ----------------------------------------- |
| `npm run chat:cli` / `node chat-cli.js`  | 일반 텍스트 채팅·관리 메뉴                |
| `npm run chat:tui` / `node chat-tui.js`  | 전체 화면 입력창·응답 표시·코드 강조 TUI  |
| `node index.js <command>`                | 자동화·디버깅용 JSON CLI                  |
| `npm run login:bg -- --account personal` | 공통 로그인 흐름을 백그라운드 모드로 시작 |
| `npm run login:it -- --account personal` | 공통 로그인 흐름을 화면 표시 모드로 시작  |
| `npm run prompt`                         | 개별 API 명령을 선택하는 개발용 메뉴      |

`prompt-chat.js`, `prompt-chat2.js`와 기존 npm 명령은 호환 진입점으로 유지됩니다. 새 코드와 문서에서는 역할이 드러나는 이름을 사용합니다. 두 채팅 화면은 계정·로그인·대화 관리 메뉴를 공유합니다.

```bash
node chat-cli.js --account personal
node chat-tui.js --account personal --new
node chat-tui.js --account personal --resume
```

TUI: Enter 전송, Ctrl+J 줄바꿈, PgUp/PgDn 스크롤, `/exit` 메뉴 복귀, `/quit` 종료.

## 계정 전환

```bash
node index.js account-add work work@gmail.com relay
node index.js --account work gmail-auth relay
node index.js account-list
node index.js account-use work
node index.js --account personal gmail-latest
```

채팅 메뉴 **9번**에서도 계정 추가·전환, **10번**에서 현재 계정의 Gmail 인증을 할 수 있습니다. 계정 옵션은 명령 앞에 둡니다. 기존 단일 계정의 `.env` 및 세션 파일은 `default` 계정으로 계속 사용합니다.

```bash
node index.js account-use default
```

선택 우선순위는 `--account` → `CLAUDE_ACCOUNT` → `account-use` → `default`입니다. 실행 중인 채팅은 선택 당시 계정에 고정되며 다른 터미널의 계정 전환에 영향을 받지 않습니다.

## 저장 구조

```text
.data/
  accounts.json                 # 계정 목록, 활성 계정, Gmail 자격 증명
  accounts/<id>/
    session-cookie-jar.json
    client-state.json
    last-chat.json
    latest-claude-code.json
    browser-profile/
src/
  accounts/                     # 계정 저장·선택·설정 격리
  chat/                         # 공통 메뉴와 CLI/TUI 화면
  cli/                          # 계정 옵션·명령·공통 로그인 진입점
  gmail/                        # 직접 Gmail, relay, OAuth, 메일 파싱
  browser/                      # Chrome 로그인 및 웹 API fallback
  claude/                       # 대화 API·응답 데이터 해석·SSE
  runtime/                      # 선택 계정의 API·쿠키·상태 조립
  config/  state/  http/         # 공통 설정·파일 상태·HTTP 전송
  auth/  arkose/  session/       # 기존 Claude 인증·로그아웃
  prompts/                      # 개발용 프롬프트와 이전 모듈 호환 경로
```

계정 저장소에는 민감한 인증 정보가 있으므로 커밋하지 않습니다. `.data/`는 Git에서 제외됩니다. `logout`은 선택한 계정의 Claude 세션만 정리하며 Gmail 연결은 유지합니다.

## 검증과 문서

```bash
npm run check
```

코드·문서 포맷, JavaScript 문법, 한국어 JSDoc의 인자·반환값, 계정 격리·인증·대화 API·CLI/TUI 회귀 테스트를 실행합니다. 형식을 자동 정리하려면 `npm run format`을 사용합니다. 실제 Google 로그인이나 Claude 메시지 전송은 자동 테스트에서 수행하지 않습니다.

- [문서 안내와 읽는 순서](docs/문서-안내.md)
- [코드 작성과 검증 규칙](docs/코드-작성과-검증-규칙.md)
- [리팩터링 변경 기록과 검증 범위](docs/리팩터링-변경-기록.md)
- [구글 클라우드와 지메일 인증 설정](docs/구글-클라우드-지메일-인증-설정.md)
- [계정 설정과 기존 환경 이전](docs/계정-설정과-이전.md)
- [Gmail relay 서버 연동 규격](docs/지메일-중계-서버-연동-규격.md)
- [모듈 구조와 개발 지침](docs/모듈-구조와-개발-지침.md)

현재 저장소에는 relay **클라이언트와 연동 테스트**가 있습니다. 운영용 Gmail 서버 배포는 별도 작업입니다.
