/**
 * 서버 응답의 중첩 구조를 순서대로 읽되 같은 객체와 순환 참조는 한 번만 방문한다.
 * @param {unknown} root - 대화 목록 또는 상세 응답
 * @returns {Generator<object>} 깊이 우선 순서의 객체 목록
 */
function* walkObjects(root) {
  const pending = [root];
  const visited = new WeakSet();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (!Array.isArray(value)) yield value;
    const children = Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
}

/**
 * Claude 응답에서 사용하는 여러 발화자 표기를 화면 표시용 역할로 통일한다.
 * @param {object} value - 메시지 후보 객체
 * @returns {string|null} user, assistant, system 중 하나 또는 null
 */
function messageRole(value) {
  const role = String(
    value.sender || value.role || value.author || value.type || value.message?.sender || value.message?.role || ""
  ).toLowerCase();
  if (role.includes("assistant")) return "assistant";
  if (role.includes("human") || role.includes("user")) return "user";
  if (role.includes("system")) return "system";
  return null;
}

/**
 * 응답 버전마다 다른 메시지 식별자 필드를 같은 기준으로 읽는다.
 * @param {object} value - 메시지 후보 객체
 * @returns {string|null} 메시지 식별자 또는 null
 */
function messageId(value) {
  const id = value.uuid || value.message_uuid || value.messageUuid || value.message?.uuid || value.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * 일반 문자열과 텍스트 블록 배열을 모두 처리해 이전 대화가 화면에서 빠지지 않도록 한다.
 * @param {object} value - 메시지 후보 객체
 * @returns {string} 표시할 텍스트 또는 빈 문자열
 */
function messageText(value) {
  const candidates = [value.text, value.content, value.body, value.message?.text, value.message?.content];
  for (const item of candidates) if (typeof item === "string" && item.trim()) return item;
  const blocks = [
    value.content,
    value.message?.content,
    value.content?.blocks,
    value.message?.content?.blocks,
    value.content_blocks
  ].find(Array.isArray);
  const texts = [];
  for (const block of blocks || []) {
    if (typeof block?.text === "string") texts.push(block.text);
    else if (typeof block?.content === "string") texts.push(block.content);
  }
  return texts.filter(Boolean).join("\n");
}

/**
 * 대화 상세 응답을 중복 없는 화면 표시용 메시지 목록으로 바꾼다.
 * @param {unknown} root - 대화 상세 응답
 * @returns {object[]} 발화자 역할과 본문이 담긴 메시지 목록
 */
export function extractMessagesFromConversation(root) {
  const messages = new Map();
  for (const value of walkObjects(root)) {
    const id = messageId(value);
    const role = messageRole(value);
    if (!id || !role || messages.has(id)) continue;
    const text = messageText(value);
    if (text.trim()) messages.set(id, { role, text });
  }
  return [...messages.values()];
}

/**
 * 대화 응답의 첫 제목을 찾아 메뉴와 TUI에서 같은 이름을 표시한다.
 * @param {unknown} root - 대화 상세 응답
 * @returns {string|null} 공백을 제거한 제목 또는 null
 */
export function extractConversationTitle(root) {
  for (const value of walkObjects(root)) {
    const title = value.name || value.title || value.chat_title || value.display_name;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return null;
}

/**
 * API와 TUI가 같은 규칙으로 직전 답변의 식별자를 찾아 후속 메시지의 부모로 사용한다.
 * @param {unknown} root - 대화 상세 응답
 * @returns {string|null} 응답 순서상 마지막 assistant 메시지 식별자
 */
export function findLatestAssistantMessageUuid(root) {
  let latest = null;
  for (const value of walkObjects(root)) {
    if (messageRole(value) === "assistant" && messageId(value)) latest = messageId(value);
  }
  return latest;
}

/**
 * 목록 응답의 포장 방식이 달라도 식별자와 제목이 있는 대화 항목을 수집한다.
 * @param {unknown} root - 대화 목록 응답
 * @returns {object[]} 원본 대화 항목 목록
 */
export function extractConversationListItems(root) {
  const items = [];
  for (const value of walkObjects(root)) {
    const id = value.uuid || value.conversation_uuid || value.conversationId || value.id;
    const title = value.name || value.title || value.chat_title || value.display_name;
    if (typeof id === "string" && typeof title === "string") items.push(value);
  }
  return items;
}
