import { expect, test as base, type ConsoleMessage, type Response, type TestInfo } from '@playwright/test';
import {
  assertExpectedBrowserEvents,
  type ExpectedBrowserEventRule,
  type ObservedBrowserResponse,
} from './expected-event-matcher.js';

export { expect };

const ignoredConsoleErrors = [
  // Chromium reports this for the existing meta CSP on every navigation. The
  // directive is ignored by browsers in meta tags, so it is tracked outside
  // Issue #60 while all other console.error messages still fail the test.
  "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.",
];

function consoleErrorRules(testInfo: TestInfo) {
  return testInfo.annotations.flatMap((annotation): ExpectedBrowserEventRule[] => {
    if (annotation.type !== 'allow-console-error-for-response') return [];
    try {
      const parsed = JSON.parse(annotation.description ?? '') as Partial<ExpectedBrowserEventRule>;
      if (parsed.testScope !== testInfo.testId || typeof parsed.consoleText !== 'string'
        || typeof parsed.method !== 'string' || typeof parsed.pathname !== 'string'
        || typeof parsed.search !== 'string'
        || typeof parsed.status !== 'number' || parsed.expectedCount !== 1) {
        throw new Error('Console error allowance must exactly match its active test scope and expected event shape.');
      }
      return [{
        testScope: parsed.testScope,
        method: parsed.method,
        pathname: parsed.pathname,
        search: parsed.search,
        status: parsed.status,
        consoleText: parsed.consoleText,
        expectedCount: parsed.expectedCount,
      }];
    } catch (error) {
      throw new Error(`Invalid console error allowance for ${testInfo.testId}.`, { cause: error });
    }
  });
}

export const test = base.extend<{ browserErrorGate: void }>({
  browserErrorGate: [async ({ page }, use, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const responses: ObservedBrowserResponse[] = [];
    const onPageError = (error: Error) => pageErrors.push(error.message);
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === 'error' && !ignoredConsoleErrors.includes(message.text())) {
        consoleErrors.push(message.text());
      }
    };
    const onResponse = (response: Response) => {
      const url = new URL(response.url());
      responses.push({
        method: response.request().method(),
        pathname: url.pathname,
        search: url.search,
        status: response.status(),
      });
    };

    page.on('pageerror', onPageError);
    page.on('console', onConsole);
    page.on('response', onResponse);
    await use();
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    page.off('response', onResponse);

    assertExpectedBrowserEvents(testInfo.testId, consoleErrorRules(testInfo), {
      consoleErrors,
      pageErrors,
      responses,
    });
  }, { auto: true }],
});
