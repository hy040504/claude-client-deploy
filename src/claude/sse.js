/**
 * Claude completion SSE 응답을 이벤트 목록으로 파싱한다.
 * @param {unknown} raw - 원본 SSE 응답 본문
 * @returns {object} 파싱된 이벤트와 이벤트 이름 목록
 */
export function parseSse(raw) {
  const text = typeof raw === "string" ? raw : String(raw || "");
  const events = [];

  for (const block of text.split(/\r?\n\r?\n/)) {
    const event = parseSseBlock(block);
    if (event) events.push(event);
  }

  return {
    events,
    eventNames: events.map(event => event.event)
  };
}

/**
 * Claude completion SSE 응답에서 채팅 결과 요약을 만든다.
 * @param {object} response - HTTP 응답 객체
 * @param {string} conversationId - 대화 ID
 * @returns {object} 채팅 응답 요약
 */
export function summarizeCompletion(response, conversationId) {
  const parsed = parseSse(response.data);
  const assistantText = parsed.events
    .filter(isTextDeltaEvent)
    .map(textFromDeltaEvent)
    .join("");
  const messageStart = parsed.events.find(isMessageStartEvent)?.data?.message;

  return {
    status: response.status,
    statusText: response.statusText,
    requestId: response.headers["request-id"],
    conversationId,
    assistantMessageUuid: messageStart?.uuid || null,
    assistantMessageId: messageStart?.id || null,
    assistantText,
    events: parsed.eventNames
  };
}

/**
 * Axios가 SSE 본문을 변형하지 않도록 원본 데이터를 그대로 반환한다.
 * @param {unknown} data - Axios transform 대상 데이터
 * @returns {unknown} 원본 데이터
 */
export function keepRawResponse(data) {
  return data;
}

/**
 * 단일 SSE block을 이벤트 객체로 변환한다.
 * @param {string} block - SSE block 문자열
 * @returns {object|null} 이벤트 객체 또는 파싱 불가 시 null
 */
function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const eventLine = lines.find(line => line.startsWith("event:"));
  const dataLine = lines.find(line => line.startsWith("data:"));
  if (!eventLine || !dataLine) return null;

  return {
    event: eventLine.slice("event:".length).trim(),
    data: parseJsonOrText(dataLine.slice("data:".length).trim())
  };
}

/**
 * SSE data 값을 JSON이면 파싱하고 아니면 문자열로 유지한다.
 * @param {string} value - SSE data 값
 * @returns {unknown} 파싱된 JSON 또는 원문 문자열
 */
function parseJsonOrText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * assistant 메시지 시작 이벤트인지 확인한다.
 * @param {object} event - SSE 이벤트
 * @returns {boolean} message_start 이벤트 여부
 */
function isMessageStartEvent(event) {
  return event.data?.type === "message_start";
}

/**
 * 텍스트 delta 이벤트인지 확인한다.
 * @param {object} event - SSE 이벤트
 * @returns {boolean} text_delta 이벤트 여부
 */
function isTextDeltaEvent(event) {
  return event.data?.type === "content_block_delta" && event.data?.delta?.type === "text_delta";
}

/**
 * 텍스트 delta 이벤트에서 assistant 텍스트를 추출한다.
 * @param {object} event - SSE 이벤트
 * @returns {string} assistant 텍스트 조각
 */
function textFromDeltaEvent(event) {
  return event.data?.delta?.text || "";
}
