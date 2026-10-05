import { setTimeout as delay } from "node:timers/promises";
import { createClaudeMailReader, findVerificationLinks } from "./latest-claude-mail.js";

/**
 * 이전 로그인 메일과 날짜가 없는 응답을 제외하고 이번 요청의 인증 메일인지 확인한다.
 * @param {object|null} mail - 직접 조회 또는 중계 서버에서 받은 메일
 * @param {number} sentAt - 로그인 요청을 보내기 직전의 시각
 * @returns {boolean} 발신자, 수신 시각, 인증 링크가 조건에 맞는지 여부
 */
export function isCurrentLoginMail(mail, sentAt) {
  if (!mail?.messageId || !Number.isFinite(Number(mail.internalDate))) return false;
  const from = String(mail.from || "").trim();
  const sender = from.match(/<([^<>]+)>\s*$/)?.[1] || from;
  // 일부 중계 서버가 밀리초를 버리므로 1초까지만 허용한다. 예전의 5분 허용은 이전 링크를 재사용할 수 있었다.
  return (
    /^[^\s@<>]+@anthropic\.com$/i.test(sender) &&
    Number(mail.internalDate) >= sentAt - 1000 &&
    findVerificationLinks({ links: mail.verificationLinks || mail.links }).length > 0
  );
}

/**
 * 하나의 Gmail 클라이언트로 새 인증 메일을 기다리며 중단 신호를 받으면 대기를 해제한다.
 * @param {object} config - 감시할 계정의 설정
 * @param {number} sentAt - 로그인 메일을 요청한 시각
 * @param {object} [options={}] - 조회 함수, 최대 대기 시간, 중단 신호
 * @returns {Promise<object|null>} 새 인증 메일 또는 제한 시간 초과 시 null
 * @throws {Error} 인증이나 메일 조회에 실패하거나 중단 신호를 받은 경우
 */
export async function waitForLoginMail(config, sentAt, options = {}) {
  const readMail = options.readMail || createClaudeMailReader(config);
  const timeoutMs = options.timeoutMs ?? 180000;
  const pollMs = options.pollMs ?? config.gmailPollMs ?? 4000;
  if (
    !Number.isFinite(sentAt) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  ) {
    throw new Error("메일 요청 시각과 대기 시간은 유효한 숫자여야 합니다.");
  }
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const abort = controller.abort.bind(controller, undefined);
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      const mail = await readMail({
        allowMissing: true,
        query: config.gmailClaudeQuery,
        maxResults: config.gmailClaudeMaxResults,
        signal: controller.signal
      });
      controller.signal.throwIfAborted();
      if (isCurrentLoginMail(mail, sentAt)) {
        return { ...mail, verificationLinks: findVerificationLinks({ links: mail.verificationLinks || mail.links }) };
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(pollMs, remaining), undefined, { signal: controller.signal });
    }
    return null;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
