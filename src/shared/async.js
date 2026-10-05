/**
 * 비동기 작업의 대기 시간을 제한하고 먼저 끝난 작업의 타이머는 즉시 정리한다.
 * @param {Promise<unknown>} promise - 완료를 기다릴 작업
 * @param {number} timeoutMs - 최대 대기 시간(밀리초)
 * @param {string} message - 제한 시간을 넘겼을 때 표시할 오류
 * @returns {Promise<unknown>} 원래 작업의 결과
 * @throws {Error} 작업 실패 또는 제한 시간 초과 시 발생
 */
export async function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(reject, timeoutMs, new Error(message));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
