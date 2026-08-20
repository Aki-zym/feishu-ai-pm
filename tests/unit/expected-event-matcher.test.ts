import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExpectedBrowserEvents,
  createIssue52ConsoleErrorRule,
  issue52ConsoleErrorText,
  type ObservedBrowserResponse,
} from '../e2e/expected-event-matcher.js';

const testScope = 'issue52-console-error-unit-contract';
const rule = createIssue52ConsoleErrorRule(testScope);
const expectedResponse: ObservedBrowserResponse = {
  method: rule.method,
  pathname: rule.pathname,
  search: rule.search,
  status: rule.status,
};

function evaluate(consoleErrors: string[], responses: ObservedBrowserResponse[], activeScope = testScope) {
  assertExpectedBrowserEvents(activeScope, [rule], { consoleErrors, pageErrors: [], responses });
}

test('Issue #52 规则固定绑定 scope、console、GET、pathname、空 search、503 和一次计数', () => {
  assert.deepEqual(rule, {
    testScope,
    consoleText: issue52ConsoleErrorText,
    method: 'GET',
    pathname: '/api/tasks/issue52-history-b',
    search: '',
    status: 503,
    expectedCount: 1,
  });
});

test('一次精确 console error 和一次精确 response 通过', () => {
  assert.doesNotThrow(() => evaluate([issue52ConsoleErrorText], [expectedResponse]));
});

test('两条相同 console error 失败', () => {
  assert.throws(
    () => evaluate([issue52ConsoleErrorText, issue52ConsoleErrorText], [expectedResponse]),
    /console\.error .* expected 1, observed 2/,
  );
});

test('两次精确 response 失败', () => {
  assert.throws(
    () => evaluate([issue52ConsoleErrorText], [expectedResponse, expectedResponse]),
    /response GET \/api\/tasks\/issue52-history-b 503 expected 1, observed 2/,
  );
});

test('不同接口出现同一 503 console 文本失败', () => {
  assert.throws(
    () => evaluate([issue52ConsoleErrorText], [{ ...expectedResponse, pathname: '/api/tasks/issue52-history-c' }]),
    /response GET \/api\/tasks\/issue52-history-b 503 expected 1, observed 0/,
  );
});

test('目标 503 与额外接口 503 同时出现也失败', () => {
  assert.throws(
    () => evaluate(
      [issue52ConsoleErrorText],
      [expectedResponse, { ...expectedResponse, pathname: '/api/tasks/issue52-history-c' }],
    ),
    /unexpected response GET \/api\/tasks\/issue52-history-c 503 observed 1/,
  );
});

test('目标 pathname 带额外 search 时失败', () => {
  assert.throws(
    () => evaluate([issue52ConsoleErrorText], [{ ...expectedResponse, search: '?retry=1' }]),
    /response GET \/api\/tasks\/issue52-history-b 503 expected 1, observed 0/,
  );
});

test('console error 缺失时失败', () => {
  assert.throws(
    () => evaluate([], [expectedResponse]),
    /console\.error .* expected 1, observed 0/,
  );
});

test('response 缺失时失败', () => {
  assert.throws(
    () => evaluate([issue52ConsoleErrorText], []),
    /response GET \/api\/tasks\/issue52-history-b 503 expected 1, observed 0/,
  );
});

test('规则 scope 与当前测试 scope 不一致时失败', () => {
  assert.throws(
    () => evaluate([issue52ConsoleErrorText], [expectedResponse], 'another-test-scope'),
    /rule scope .* does not match active test scope/,
  );
});
