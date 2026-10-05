import { parse } from "acorn";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * 들여쓰기와 선언 방식에 영향받지 않고 함수 및 주석 위치를 찾는다.
 * @param {string} source - JavaScript 소스 문자열
 * @returns {{functions: object[], comments: object[]}} 이름 있는 함수와 전체 주석
 */
export function analyzeSource(source) {
  const comments = [];
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, onComment: comments });
  const functions = [];
  visit(tree, []);
  return { functions, comments };

  /**
   * 구문 트리를 순회하며 선언문과 그 앞의 설명을 연결한다.
   * @param {object} node - 검사할 구문 노드
   * @param {object[]} ancestors - 해당 노드를 감싸는 상위 노드
   * @returns {void} 반환값 없음
   */
  function visit(node, ancestors) {
    const parent = ancestors.at(-1);
    if (FUNCTION_TYPES.has(node.type)) {
      const anchor = functionAnchor(node, ancestors);
      if (anchor) {
        const previous = comments.findLast(comment => comment.end <= anchor.start);
        const jsdoc =
          previous?.type === "Block" &&
          previous.value.startsWith("*") &&
          !source.slice(previous.end, anchor.start).trim()
            ? previous
            : null;
        functions.push({ name: functionName(node, parent, source), node, anchor, jsdoc, line: node.loc.start.line });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, [...ancestors, node]);
      } else if (value?.type) visit(value, [...ancestors, node]);
    }
  }
}

/**
 * 선언문을 감싼 export·변수·메서드까지 포함해 JSDoc 부착 위치를 찾는다.
 * @param {object} node - 함수 노드
 * @param {object[]} ancestors - 상위 구문 노드
 * @returns {object|null} 설명을 붙일 선언 또는 인라인 콜백이면 null
 */
function functionAnchor(node, ancestors) {
  let anchor = node;
  const parent = ancestors.at(-1);
  if (parent?.type === "VariableDeclarator") anchor = ancestors.at(-2);
  else if (["Property", "MethodDefinition"].includes(parent?.type)) anchor = parent;
  else if (parent?.type === "AssignmentExpression") anchor = ancestors.at(-2);
  else if (!node.id) return null;
  const wrapper = ancestors.findLast(
    candidate => candidate.declaration === anchor && candidate.type.startsWith("Export")
  );
  return wrapper || anchor;
}

/**
 * 검사 결과에 사용할 함수 이름을 선언 형태에 맞춰 읽는다.
 * @param {object} node - 함수 노드
 * @param {object} parent - 함수 바로 위의 구문 노드
 * @param {string} source - 원본 소스
 * @returns {string} 함수·변수·메서드 이름
 */
function functionName(node, parent, source) {
  if (node.id) return node.id.name;
  const identifier = parent.id || parent.key || parent.left;
  return identifier ? source.slice(identifier.start, identifier.end) : "익명 함수";
}

/**
 * JSDoc의 설명 언어와 실제 매개변수·반환값 표기가 일치하는지 검사한다.
 * @param {string} source - 검사할 소스
 * @returns {object[]} 줄 번호, 함수 이름, 오류 설명 목록
 */
export function checkSourceDocumentation(source) {
  const { functions, comments } = analyzeSource(source);
  const failures = [];
  for (const entry of functions) {
    const issues = checkFunctionDocumentation(entry);
    for (const message of issues) failures.push({ line: entry.line, name: entry.name, message });
  }
  for (const comment of comments) {
    const meaningful = comment.value.replace(/[*\s=\-]/g, "");
    if (meaningful && !/[가-힣]/.test(comment.value)) {
      failures.push({ line: comment.loc.start.line, name: "주석", message: "설명을 한국어로 작성하세요." });
    }
  }
  return failures;
}

/**
 * 함수별 설명, 인자 이름, 반환값 태그 누락을 찾는다.
 * @param {object} entry - 함수와 연결된 JSDoc 정보
 * @returns {string[]} 수정해야 할 설명 목록
 */
function checkFunctionDocumentation(entry) {
  if (!entry.jsdoc) return ["한국어 JSDoc이 없습니다."];
  const text = entry.jsdoc.value;
  const issues = [];
  const description = text.split(/@\w+/)[0];
  if (!/[가-힣]/.test(description)) issues.push("함수의 목적을 한국어로 설명하세요.");
  if (!/@returns?\s+\{[^\n]+\}\s+[^\n]*[가-힣]/.test(text)) issues.push("@returns에 타입과 한국어 설명이 필요합니다.");
  const tags = [...text.matchAll(/@param\s+\{[^\n]+?\}\s+(\[[^\]]+\]|\S+)\s*-?\s*([^\n]*)/g)];
  const roots = tags.filter(isRootParameterTag);
  if (roots.length !== entry.node.params.length)
    issues.push(`@param 개수가 실제 인자 ${entry.node.params.length}개와 다릅니다.`);
  for (let index = 0; index < entry.node.params.length; index += 1) {
    const parameter = entry.node.params[index];
    const target =
      parameter.type === "AssignmentPattern"
        ? parameter.left
        : parameter.type === "RestElement"
          ? parameter.argument
          : parameter;
    const tag = roots[index];
    if (!tag) continue;
    const name = normalizeParameterName(tag[1]);
    if (target.type === "Identifier" && name !== target.name)
      issues.push(`@param ${name} 대신 실제 이름 ${target.name}을 사용하세요.`);
    if (!/[가-힣]/.test(tag[2])) issues.push(`@param ${name}의 용도를 한국어로 설명하세요.`);
  }
  return issues;
}

/**
 * 선택 인자와 기본값 표기를 제거해 코드의 인자 이름과 비교한다.
 * @param {string} value - JSDoc 인자 이름
 * @returns {string} 비교할 인자 이름
 */
function normalizeParameterName(value) {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split("=")[0]
    .replace(/^\.\.\./, "");
}

/**
 * 객체 속성 설명을 실제 함수 인자 개수에 중복해서 세지 않는다.
 * @param {string[]} tag - 정규식으로 읽은 JSDoc 인자 태그
 * @returns {boolean} 최상위 인자 여부
 */
function isRootParameterTag(tag) {
  return !normalizeParameterName(tag[1]).includes(".");
}
