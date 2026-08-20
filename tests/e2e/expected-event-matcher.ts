export type ExpectedBrowserEventRule = {
  testScope: string;
  method: string;
  pathname: string;
  search: string;
  status: number;
  consoleText: string;
  expectedCount: 1;
};

export type ObservedBrowserResponse = {
  method: string;
  pathname: string;
  search: string;
  status: number;
};

export type BrowserEventObservations = {
  consoleErrors: string[];
  pageErrors: string[];
  responses: ObservedBrowserResponse[];
};

function countBy<T>(values: T[], keyOf: (value: T) => string) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export const issue52ConsoleErrorText = 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';

export function createIssue52ConsoleErrorRule(testScope: string): ExpectedBrowserEventRule {
  return {
    testScope,
    consoleText: issue52ConsoleErrorText,
    method: 'GET',
    pathname: '/api/tasks/issue52-history-b',
    search: '',
    status: 503,
    expectedCount: 1,
  };
}

function responseKey(response: ObservedBrowserResponse) {
  return `${response.method} ${response.pathname}${response.search} ${response.status}`;
}

export function assertExpectedBrowserEvents(
  testScope: string,
  rules: ExpectedBrowserEventRule[],
  observations: BrowserEventObservations,
) {
  const failures = observations.pageErrors.map((message) => `unexpected pageerror: ${message}`);
  const expectedConsoleCounts = new Map<string, number>();
  const expectedResponseCounts = new Map<string, number>();
  const guardedResponseStatuses = new Set<number>();

  for (const rule of rules) {
    if (rule.testScope !== testScope) {
      failures.push(`rule scope ${JSON.stringify(rule.testScope)} does not match active test scope ${JSON.stringify(testScope)}`);
      continue;
    }
    expectedConsoleCounts.set(
      rule.consoleText,
      (expectedConsoleCounts.get(rule.consoleText) ?? 0) + rule.expectedCount,
    );
    const key = responseKey(rule);
    expectedResponseCounts.set(key, (expectedResponseCounts.get(key) ?? 0) + rule.expectedCount);
    guardedResponseStatuses.add(rule.status);
  }

  const observedConsoleCounts = countBy(observations.consoleErrors, (message) => message);
  const observedResponseCounts = countBy(observations.responses, responseKey);

  for (const [consoleText, expectedCount] of expectedConsoleCounts) {
    const observedCount = observedConsoleCounts.get(consoleText) ?? 0;
    if (observedCount !== expectedCount) {
      failures.push(`console.error ${JSON.stringify(consoleText)} expected ${expectedCount}, observed ${observedCount}`);
    }
  }
  for (const [consoleText, observedCount] of observedConsoleCounts) {
    if (!expectedConsoleCounts.has(consoleText)) {
      failures.push(`unexpected console.error ${JSON.stringify(consoleText)} observed ${observedCount}`);
    }
  }
  for (const [key, expectedCount] of expectedResponseCounts) {
    const observedCount = observedResponseCounts.get(key) ?? 0;
    if (observedCount !== expectedCount) {
      failures.push(`response ${key} expected ${expectedCount}, observed ${observedCount}`);
    }
  }
  const unexpectedResponseCounts = countBy(
    observations.responses.filter((response) => (
      guardedResponseStatuses.has(response.status) && !expectedResponseCounts.has(responseKey(response))
    )),
    responseKey,
  );
  for (const [key, observedCount] of unexpectedResponseCounts) {
    failures.push(`unexpected response ${key} observed ${observedCount}`);
  }

  if (failures.length > 0) {
    throw new Error(`Browser event gate failed for ${JSON.stringify(testScope)}:\n- ${failures.join('\n- ')}`);
  }
}
