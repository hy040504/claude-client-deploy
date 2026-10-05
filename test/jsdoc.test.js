import test from "node:test";
import assert from "node:assert/strict";
import { checkSourceDocumentation } from "../scripts/lib/jsdoc-analysis.js";

test("JSDoc 검사는 export 함수와 중첩 함수·화살표·클래스 메서드를 모두 확인한다", () => {
  const source = `
    /** 외부 함수를 설명한다.
     * @param {string} value - 입력 문자열
     * @returns {string} 원본 문자열
     */
    export function outer(value) {
      function inner() {}
      const arrow = (x) => x;
      return value;
    }
    class Example { method() {} }
  `;
  const failures = checkSourceDocumentation(source);
  assert.deepEqual(
    failures.map(item => item.name),
    ["inner", "arrow", "method"]
  );
});

test("실제 인자와 맞지 않는 태그·반환값 누락·영어만 있는 설명을 찾는다", () => {
  const source = `
    /** 입력을 반환한다.
     * @param {string} wrong - English only
     */
    export const echo = value => value;
    // English comment
  `;
  const messages = checkSourceDocumentation(source)
    .map(item => item.message)
    .join(" ");
  assert.match(messages, /@returns/);
  assert.match(messages, /실제 이름 value/);
  assert.match(messages, /한국어/);
});

test("선택 인자·객체 속성·나머지 인자와 export 화살표의 올바른 JSDoc은 허용한다", () => {
  const source = `
    /** 검색 옵션을 반환한다.
     * @param {object} [options={}] - 검색 설정
     * @param {string} options.query - 검색어
     * @returns {object} 검색 설정
     */
    export const read = (options = {}) => options;
    /** 입력 목록을 반환한다.
     * @param {...string} values - 입력 목록
     * @returns {string[]} 입력 목록
     */
    function list(...values) { return values; }
  `;
  assert.deepEqual(checkSourceDocumentation(source), []);
});
