export {
  extractMessagesFromConversation,
  extractConversationTitle,
  findLatestAssistantMessageUuid
} from "../claude/conversation-data.js";

const DEFAULT_MODEL_CHOICES = ["claude-sonnet-4-6", "claude-opus-4-5", "claude-haiku-4-5"];

/**
 * 기본 모델과 추천 목록을 합쳐 중복 없는 모델 목록을 만든다
 * @param {string} defaultModel - 기본 모델 이름
 * @returns {string[]} 중복 제거된 모델 목록
 */
export function uniqueModels(defaultModel) {
  return [...new Set([defaultModel, ...DEFAULT_MODEL_CHOICES].filter(Boolean))];
}
