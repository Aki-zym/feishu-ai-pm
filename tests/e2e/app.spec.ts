import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { createIssue52ConsoleErrorRule } from './expected-event-matcher.js';

// 以下日期只是假数据中的业务时间，不是审计或验收日期。
const e2eHealthDependencies = () => Object.fromEntries(['token', 'freshness', 'backoff', 'disk'].map((name) => [name, {
  status: 'ready', error_code: null, observed_at: '2026-08-15T01:00:00.000Z', details: {},
}]));

const issue52TaskDetail = (id: string, title: string) => ({
  id,
  title,
  proposer_name: 'E2E 需求方',
  describe: `${title} 的私人任务摘要。`,
  status: 'unplanned',
  schedule_at: null,
  planned_start_at: null,
  planned_due_at: null,
  next_step: '核对任务详情身份。',
  risk: 'medium',
  waiting_reason: null,
  version: 1,
  completed_at: null,
  archived_at: null,
  deleted_at: null,
  record_state: 'active',
  merged_into_task_id: null,
  auto_update_paused: false,
  created_at: '2026-08-15T08:00:00.000Z',
  updated_at: '2026-08-15T08:00:00.000Z',
  sources: [],
  events: [],
  references: [],
  approvals: [],
  thread: null,
  update_proposals: [],
  auto_updates: [],
  memory_projection: null,
  runtime_jobs: [],
});

const openIssue52Task = async (page: Page, taskId: string) => {
  await page.evaluate((nextTaskId) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('task', nextTaskId);
    window.history.pushState({}, '', `${nextUrl.pathname}${nextUrl.search}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, taskId);
};

const candidateCardById = (page: Page, candidateId: string) =>
  page.locator(`article.candidate-card[data-candidate-id="${candidateId}"]`);

const seedPendingCandidate = async (page: Page, title: string) => {
  const response = await page.request.post('/api/dev/seed-intake', {
    data: {
      title,
      describe: `${title} 的浏览器验收描述。`,
      background: `${title} 的浏览器验收背景。`,
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { candidate_id?: string };
  expect(body.candidate_id).toEqual(expect.any(String));
  return body.candidate_id as string;
};

const issue57Candidate = {
  id: 'issue57-candidate',
  source_event_id: 'issue57-source',
  title: 'Issue #57 外链反馈候选',
  proposer_name: 'E2E 需求方',
  background: '验证飞书文档外链。',
  validation_question: '允许和拒绝是否都有可见结果？',
  describe: '只使用合成链接测试 renderer 合同。',
  confidence: 0.95,
  state: 'pending',
  snoozed_until: null,
  accepted_task_id: null,
  deleted_at: null,
  created_at: '2026-08-15T08:00:00.000Z',
  updated_at: '2026-08-15T08:00:00.000Z',
  source_type: 'owner_dm',
  owner_mentioned: 0,
  source_completeness: 'complete',
  discovery_reason: 'E2E 合成外链合同',
  processing_state: 'ready',
  processing_error: null,
  context_state: 'complete',
  context_reason: null,
  recovered_at: null,
  analysis: {
    timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
    fieldBasis: { background: 'fact', validationQuestion: 'fact', describe: 'fact' },
    recognitionEvidence: ['E2E 合成识别依据'],
    linkedDocuments: [
      { documentType: 'docx', status: 'ready', freshness: 'fresh', completeness: 'complete', truncated: false },
      { documentType: 'docx', status: 'unsupported', freshness: 'stale', completeness: 'limited', truncated: true },
    ],
    sourceRevision: 'synthetic-source-57',
    contextRevision: 'synthetic-context-57',
  },
};

test('工作台、任务详情和安全边界可访问', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await expect(page.getByText('系统自动记录线索，不会执行任何业务任务')).toBeVisible();
  await page.getByText('活动引流渠道效果复盘', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '活动引流渠道效果复盘' })).toBeVisible();
  await expect(page.getByLabel('任务详情', { exact: true }).getByText('谁向我提出')).toBeVisible();
  await expect(page.getByText('只生成、审阅、修改或废止，不发送')).toBeVisible();
  await page.getByRole('button', { name: '纠错' }).click();
  await expect(page.getByText('这里只修正本机任务记录')).toBeVisible();
  await expect(page.getByRole('button', { name: '记录私人纠错' })).toBeVisible();
  await page.getByLabel('哪里判断错了').selectOption('wrong_association');
  await expect(page.getByText('要移动的具体需求')).toBeVisible();
  await expect(page.getByLabel('要移动的具体需求')).toBeVisible();
});

test('Issue #49 工作台在加载后显示彼此独立的上海日统计', async ({ page }) => {
  let releaseDashboard!: () => void;
  const dashboardRelease = new Promise<void>((resolve) => { releaseDashboard = resolve; });
  const todayTask = { ...issue52TaskDetail('issue49-today', '上海今日计划'), status: 'planned', planned_due_at: '2026-08-15T10:00:00.000Z', schedule_at: '2026-08-15T10:00:00.000Z' };
  const waitingTask = { ...issue52TaskDetail('issue49-waiting', '等待需求方补充'), status: 'waiting' };

  await page.route('**/api/dashboard', async (route) => {
    await dashboardRelease;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [], today: [todayTask], waiting: [waitingTask],
        counts: { candidates: 12, today: 10, waiting: 9, inProgress: 4, overdue: 2 },
        asOf: '2026-08-15T00:30:00.000Z', todayDate: '2026-08-15', timezone: 'Asia/Shanghai', dataMode: 'local_mock',
      }),
    });
  });
  await page.route('**/api/notifications**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });

  await page.goto('/');
  await expect(page.getByText('正在整理你的任务台账…')).toBeVisible();
  releaseDashboard();
  await expect(page.getByRole('heading', { name: '需要我确认 (12)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '今天推进 (10)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '等待他人 (9)' })).toBeVisible();
  await expect(page.getByLabel('任务统计').getByText('进行中')).toBeVisible();
  await expect(page.getByLabel('任务统计').getByText('4', { exact: true })).toBeVisible();
  await expect(page.getByLabel('任务统计').getByText('2', { exact: true })).toBeVisible();
  await expect(page.getByText(todayTask.title, { exact: true })).toBeVisible();
  await expect(page.getByText(waitingTask.title, { exact: true })).toBeVisible();
  await expect(page.getByText('统计日：2026-08-15 · 时区：Asia/Shanghai · 本地模拟模式')).toBeVisible();
});

test('Issue #49 工作台失败后可重试为空状态', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: test.info().testId,
      consoleText: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      method: 'GET',
      pathname: '/api/dashboard',
      search: '',
      status: 503,
      expectedCount: 1,
    }),
  });
  let dashboardAttempts = 0;
  let dashboardAvailable = false;
  await page.route('**/api/dashboard', async (route) => {
    dashboardAttempts += 1;
    if (!dashboardAvailable) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成工作台暂不可用。' }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [], today: [], waiting: [],
        counts: { candidates: 0, today: 0, waiting: 0, inProgress: 0, overdue: 0 },
        asOf: '2026-08-15T00:30:00.000Z', todayDate: '2026-08-15', timezone: 'Asia/Shanghai', dataMode: 'configured',
      }),
    });
  });
  await page.route('**/api/notifications**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'issue49-dashboard-failure-notice', task_id: null, task_title: null, candidate_title: '独立提醒仍可读取', reason: '工作台主数据暂时不可用，但提醒分区仍然可用。', created_at: '2026-08-15T01:00:00.000Z', dedupe_key: 'issue49-dashboard-failure' }] }) });
  });

  await page.goto('/');
  await expect(page.getByRole('alert')).toHaveText('工作台读取失败：合成工作台暂不可用。');
  await expect(page.getByText('独立提醒仍可读取', { exact: true })).toBeVisible();
  await expect(page.getByText('正在整理你的任务台账…')).toHaveCount(0);
  const attemptsBeforeRetry = dashboardAttempts;
  dashboardAvailable = true;
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByText('这里还没有候选需求。回到 Cindy 说「扫近10分钟」即可扫描已授权消息。')).toBeVisible();
  await expect(page.getByText('这里还没有任务。')).toBeVisible();
  await expect(page.getByText('没有正在等待他人的任务。')).toBeVisible();
  await expect(page.getByText('外部适配器已配置')).toBeVisible();
  expect(dashboardAttempts).toBe(attemptsBeforeRetry + 1);
});

test('Issue #51 标记提醒已读后，迟到的旧刷新响应不会让提醒重新出现', async ({ page }) => {
  let releaseOldRefresh!: () => void;
  const oldRefresh = new Promise<void>((resolve) => { releaseOldRefresh = resolve; });
  let notificationGets = 0;
  const notification = {
    id: 'issue51-notification-mutation-fence',
    task_id: null,
    task_title: null,
    candidate_title: '需要确认的提醒',
    reason: '这是用于验证 mutation fence 的合成提醒。',
    created_at: '2026-08-15T01:00:00.000Z',
    dedupe_key: 'issue51-notification-mutation-fence',
  };
  await page.route('**/api/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [], today: [], waiting: [],
        counts: { candidates: 0, today: 0, waiting: 0, inProgress: 0, overdue: 0 },
        asOf: '2026-08-15T00:30:00.000Z', todayDate: '2026-08-15', timezone: 'Asia/Shanghai', dataMode: 'local_mock',
      }),
    });
  });
  await page.route('**/api/notifications**', async (route) => {
    if (route.request().method() === 'GET') {
      notificationGets += 1;
      if (notificationGets === 2) await oldRefresh;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [notification] }) });
      return;
    }
    if (route.request().method() === 'POST' && new URL(route.request().url()).pathname.endsWith('/read')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByText(notification.candidate_title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByRole('button', { name: '标记已读' }).click();
  await expect(page.getByText(notification.candidate_title, { exact: true })).toHaveCount(0);
  releaseOldRefresh();
  await expect(page.getByText(notification.candidate_title, { exact: true })).toHaveCount(0);
  expect(notificationGets).toBe(2);
});

test('Issue #50 排期日历按上海自然日展开跨日任务并保持窄屏可读', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const task = (id: string, title: string, patch: Record<string, unknown>) => ({
    ...issue52TaskDetail(id, title),
    status: 'planned',
    next_step: '核对上海自然日覆盖范围并保留私人计划边界。',
    ...patch,
  });
  const safeInstant = (value: unknown) => {
    if (typeof value !== 'string') return null;
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
  };
  const calendarItem = (detail: ReturnType<typeof task>) => {
    const displayStartAt = safeInstant(detail.planned_start_at);
    const displayDueAt = safeInstant(detail.planned_due_at);
    const displayScheduleAt = safeInstant(detail.schedule_at);
    const displayAnchorAt = displayStartAt ?? displayDueAt ?? displayScheduleAt;
    if (!displayAnchorAt) throw new Error('合成 Calendar DTO 缺少安全展示锚点。');
    return {
      id: detail.id,
      title: detail.title,
      status: detail.status,
      next_step: detail.next_step,
      display_start_at: displayStartAt,
      display_due_at: displayDueAt,
      display_schedule_at: displayScheduleAt,
      display_anchor_at: displayAnchorAt,
    };
  };
  const midnightEnd = task('issue50-midnight-end', '午夜结束任务', {
    planned_start_at: '2026-08-14T15:00:00.000Z',
    planned_due_at: '2026-08-14T16:00:00.000Z',
    schedule_at: '2026-08-14T16:00:00.000Z',
  });
  const crossDay = task('issue50-cross-day', '跨两日任务', {
    planned_start_at: '2026-08-14T15:00:00.000Z',
    planned_due_at: '2026-08-15T02:00:00.000Z',
    schedule_at: '2026-08-15T02:00:00.000Z',
  });
  const multiYear = task('issue50-multi-year', '跨年多日且标题足够长以验证手机端不会产生横向滚动的任务', {
    planned_start_at: '2025-12-31T15:00:00.000Z',
    planned_due_at: '2026-01-01T17:00:00.000Z',
    schedule_at: '2026-01-01T17:00:00.000Z',
  });
  const multiMonth = task('issue50-multi-month', '跨月多日任务', {
    planned_start_at: '2026-01-30T16:00:00.000Z',
    planned_due_at: '2026-02-02T16:00:00.000Z',
    schedule_at: '2026-02-02T16:00:00.000Z',
  });
  const completed = task('issue50-completed', '已完成历史任务仍显示', {
    status: 'completed',
    planned_due_at: '2026-08-14T17:00:00.000Z',
    schedule_at: '2026-08-14T17:00:00.000Z',
    completed_at: '2026-08-15T00:00:00.000Z',
  });
  const legacy = task('issue50-legacy', '旧版单锚点任务', {
    schedule_at: '2026-08-15T15:59:59.999Z',
  });
  const badStartGoodDue = task('issue50-bad-start-good-due', '坏开始但有效截止仍显示', {
    planned_start_at: 'browser-bad-start-canary',
    planned_due_at: '2026-08-15T03:00:00.000Z',
    schedule_at: '2026-08-15T03:00:00.000Z',
  });
  const badRangeGoodSchedule = task('issue50-bad-range-good-schedule', '坏区间但有效旧锚点仍显示', {
    planned_start_at: 'browser-bad-start-canary',
    planned_due_at: 'browser-bad-due-canary',
    schedule_at: '2026-08-15T04:00:00.000Z',
  });
  const calendarBody = {
    asOf: '2026-08-15T00:30:00.000Z',
    timezone: 'Asia/Shanghai',
    warning: '部分异常排期未显示。',
    omittedCount: 3,
    days: [
      { date: '2025-12-31', items: [calendarItem(multiYear)] },
      { date: '2026-01-01', items: [calendarItem(multiYear)] },
      { date: '2026-01-02', items: [calendarItem(multiYear)] },
      { date: '2026-01-31', items: [calendarItem(multiMonth)] },
      { date: '2026-02-01', items: [calendarItem(multiMonth)] },
      { date: '2026-02-02', items: [calendarItem(multiMonth)] },
      { date: '2026-08-14', items: [calendarItem(midnightEnd), calendarItem(crossDay)] },
      {
        date: '2026-08-15',
        items: [
          calendarItem(crossDay),
          calendarItem(completed),
          calendarItem(legacy),
          calendarItem(badStartGoodDue),
          calendarItem(badRangeGoodSchedule),
        ],
      },
    ],
  };
  expect(JSON.stringify(calendarBody)).not.toContain('browser-bad-start-canary');
  expect(JSON.stringify(calendarBody)).not.toContain('browser-bad-due-canary');

  const calendarSourcesBody = {
    timezone: 'Asia/Shanghai',
    items: [
      {
        title: '普通提醒来源事实', startAt: '2026-08-15T01:00:00.000Z', endAt: null,
        route: 'calendar_fact', sourceRetained: true, candidateCreated: false, requiresOwnerConfirmation: false,
        explanationCode: 'calendar_reminder', evidenceFields: { sourceReference: 'sha256:1111111111111111' }, correctionScope: 'current_event_only',
      },
      {
        title: '责任边界待确认', startAt: '2026-08-15T02:00:00.000Z', endAt: null,
        route: 'owner_confirmation', sourceRetained: true, candidateCreated: false, requiresOwnerConfirmation: true,
        explanationCode: 'confirmation_missing_owner_or_delivery', evidenceFields: { sourceReference: 'sha256:2222222222222222', missingSignalCode: 'missing_owner_responsibility' }, correctionScope: 'current_event_only',
      },
      {
        title: '明确交付待确认候选', startAt: '2026-08-15T03:00:00.000Z', endAt: null,
        route: 'candidate_review', sourceRetained: true, candidateCreated: true, requiresOwnerConfirmation: true,
        explanationCode: 'candidate_explicit_delivery', evidenceFields: { sourceReference: 'sha256:3333333333333333', ownerResponsibility: '我负责', action: '提交', deliverableOrDeadline: '报告' }, correctionScope: 'current_event_only',
      },
    ],
  };

  await page.route('**/api/calendar', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(calendarBody),
    });
  });
  await page.route('**/api/calendar/sources*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(calendarSourcesBody) });
  });
  await page.route(`**/api/tasks/${badStartGoodDue.id}`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(badStartGoodDue) });
  });

  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: '排期日历' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '日历来源事实' })).toBeVisible();
  await expect(page.getByText('时间事实', { exact: true })).toBeVisible();
  await expect(page.getByText('待主人确认', { exact: true })).toBeVisible();
  await expect(page.getByText('待确认候选', { exact: true })).toBeVisible();
  await expect(page.locator('.calendar-source-card')).toHaveCount(3);
  await expect(page.getByText(/按 Asia\/Shanghai 自然日展示 · 数据截至 .*2026年8月15日/)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('部分异常排期未显示。');
  await expect(page.getByRole('alert')).toContainText('已隐藏 3 项异常排期，其他正常任务仍可查看。');
  const august14 = page.getByLabel('2026-08-14 排期');
  const august15 = page.getByLabel('2026-08-15 排期');
  await expect(august14.getByText(midnightEnd.title, { exact: true })).toBeVisible();
  await expect(august15.getByText(midnightEnd.title, { exact: true })).toHaveCount(0);
  await expect(page.getByText(crossDay.title, { exact: true })).toHaveCount(2);
  await expect(page.getByText(multiYear.title, { exact: true })).toHaveCount(3);
  await expect(page.getByText(multiMonth.title, { exact: true })).toHaveCount(3);
  await expect(august15.getByText(completed.title, { exact: true })).toBeVisible();
  await expect(august15.getByText(legacy.title, { exact: true })).toBeVisible();
  await expect(august15.getByText(badStartGoodDue.title, { exact: true })).toBeVisible();
  await expect(august15.getByText(badRangeGoodSchedule.title, { exact: true })).toBeVisible();
  await expect(page.getByText('已归档任务', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const dateBox = await august15.locator('.calendar-date').boundingBox();
  const itemsBox = await august15.locator('.calendar-items').boundingBox();
  expect(dateBox).not.toBeNull();
  expect(itemsBox).not.toBeNull();
  if (testInfo.project.name === 'browser-mobile-chromium') {
    expect(itemsBox!.y).toBeGreaterThanOrEqual(dateBox!.y + dateBox!.height - 1);
  } else {
    expect(itemsBox!.x).toBeGreaterThan(dateBox!.x);
  }
  await august15.getByRole('button', { name: new RegExp(badStartGoodDue.title) }).click();
  await expect(page.getByLabel('任务详情', { exact: true }).getByRole('heading', { name: badStartGoodDue.title })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('task')).toBe(badStartGoodDue.id);
  expect(pageErrors).toEqual([]);
});

test('Issue #85 CalendarPage 在精确 320 CSS px 下渲染三类来源且内容有界', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const longBoundedTitle = 'x'.repeat(160);
  const calendarSourcesBody = {
    timezone: 'Asia/Shanghai',
    items: [
      {
        title: '保留的时间事实',
        startAt: '2026-08-17T01:00:00.000Z',
        endAt: null,
        route: 'calendar_fact',
        sourceRetained: true,
        candidateCreated: false,
        requiresOwnerConfirmation: false,
        explanationCode: 'calendar_reminder',
        evidenceFields: { sourceReference: 'sha256:1111111111111111' },
        correctionScope: 'current_event_only',
      },
      {
        title: '责任待确认',
        startAt: '2026-08-17T02:00:00.000Z',
        endAt: null,
        route: 'owner_confirmation',
        sourceRetained: true,
        candidateCreated: false,
        requiresOwnerConfirmation: true,
        explanationCode: 'confirmation_missing_owner_or_delivery',
        evidenceFields: { sourceReference: 'sha256:2222222222222222', missingSignalCode: 'missing_owner_responsibility' },
        correctionScope: 'current_event_only',
      },
      {
        title: longBoundedTitle,
        startAt: '2026-08-17T03:00:00.000Z',
        endAt: null,
        route: 'candidate_review',
        sourceRetained: true,
        candidateCreated: true,
        requiresOwnerConfirmation: true,
        explanationCode: 'candidate_explicit_delivery',
        evidenceFields: { sourceReference: 'sha256:3333333333333333', ownerResponsibility: '我负责', action: '提交', deliverableOrDeadline: '报告' },
        correctionScope: 'current_event_only',
      },
    ],
  };
  await page.route('**/api/calendar', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asOf: '2026-08-17T00:30:00.000Z', timezone: 'Asia/Shanghai', warning: null, omittedCount: 0, days: [] }),
    });
  });
  await page.route('**/api/calendar/sources*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(calendarSourcesBody) });
  });

  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: '日历来源事实' })).toBeVisible();
  await expect(page.getByText('时间事实', { exact: true })).toBeVisible();
  await expect(page.getByText('待主人确认', { exact: true })).toBeVisible();
  await expect(page.getByText('待确认候选', { exact: true })).toBeVisible();
  await expect(page.locator('.calendar-source-card')).toHaveCount(3);
  await expect(page.getByText(longBoundedTitle, { exact: true })).toBeVisible();
  const layout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    cardWidths: [...document.querySelectorAll<HTMLElement>('.calendar-source-card')].map((card) => card.getBoundingClientRect().width),
    cardTextLengths: [...document.querySelectorAll<HTMLElement>('.calendar-source-card')].map((card) => (card.textContent ?? '').length),
    bodyText: document.body.innerText,
  }));
  expect(layout.innerWidth).toBe(320);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.cardWidths.every((width) => width <= layout.clientWidth)).toBe(true);
  expect(layout.cardTextLengths.every((length) => length <= 420)).toBe(true);
  expect(layout.bodyText).not.toContain('provider_payload');
  expect(layout.bodyText).not.toContain('sourceEventId');
});

test('Issue #52 从慢任务 A 切到 B 后丢弃 A 的迟到详情', async ({ page }) => {
  const taskA = issue52TaskDetail('issue52-task-a', 'Issue #52 慢任务 A');
  const taskB = issue52TaskDetail('issue52-task-b', 'Issue #52 当前任务 B');
  let releaseTaskA!: () => void;
  const taskARelease = new Promise<void>((resolve) => { releaseTaskA = resolve; });
  let taskARequests = 0;
  let taskAResponses = 0;

  await page.route('**/api/tasks**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET' && pathname === '/api/tasks') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [taskA, taskB] }) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/tasks/${taskA.id}`) {
      taskARequests += 1;
      await taskARelease;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskA) });
      taskAResponses += 1;
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/tasks/${taskB.id}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskB) });
      return;
    }
    await route.abort();
  });

  await page.goto('/tasks');
  await openIssue52Task(page, taskA.id);
  const drawer = page.getByLabel('任务详情', { exact: true });
  await expect.poll(() => taskARequests).toBe(1);
  await expect(drawer.getByRole('heading', { name: '正在读取…' })).toBeVisible();

  await openIssue52Task(page, taskB.id);
  await expect(drawer.getByRole('heading', { name: taskB.title })).toBeVisible();
  releaseTaskA();
  await expect.poll(() => taskAResponses).toBe(1);
  await expect(drawer.getByRole('heading', { name: taskA.title })).toHaveCount(0);
  await expect(drawer.getByRole('heading', { name: taskB.title })).toBeVisible();
});

test('Issue #52 切换失败时清空 A，并在前进后退后只操作当前任务', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify(createIssue52ConsoleErrorRule(test.info().testId)),
  });
  const taskA = issue52TaskDetail('issue52-history-a', 'Issue #52 历史任务 A');
  const taskB = issue52TaskDetail('issue52-history-b', 'Issue #52 历史任务 B');
  let releaseFailedTaskB!: () => void;
  const failedTaskBRelease = new Promise<void>((resolve) => { releaseFailedTaskB = resolve; });
  let failTaskB = true;
  const mutationPaths: string[] = [];

  await page.route('**/api/tasks**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET' && pathname === '/api/tasks') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [taskA, taskB] }) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/tasks/${taskA.id}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskA) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/tasks/${taskB.id}`) {
      if (failTaskB) {
        await failedTaskBRelease;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '任务 B 读取失败。' }) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskB) });
      }
      return;
    }
    if (request.method() === 'PATCH' && pathname === `/api/tasks/${taskB.id}/automation`) {
      mutationPaths.push(pathname);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...taskB, auto_update_paused: true, version: 2 }),
      });
      return;
    }
    mutationPaths.push(`${request.method()} ${pathname}`);
    await route.abort();
  });

  await page.goto('/tasks');
  await openIssue52Task(page, taskA.id);
  const drawer = page.getByLabel('任务详情', { exact: true });
  await expect(drawer.getByRole('heading', { name: taskA.title })).toBeVisible();
  await drawer.getByRole('button', { name: '编辑任务' }).click();
  await drawer.getByLabel('任务标题').fill('不应泄漏到 B 的 A 表单');

  await openIssue52Task(page, taskB.id);
  await expect(drawer.getByRole('heading', { name: '正在读取…' })).toBeVisible();
  await expect(drawer.getByText(taskA.title, { exact: true })).toHaveCount(0);
  await expect(drawer.getByLabel('任务编辑')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '删除任务' })).toHaveCount(0);

  releaseFailedTaskB();
  await expect(drawer.getByText('任务 B 读取失败。', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: '编辑任务' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '生成对外更新草稿' })).toHaveCount(0);
  expect(mutationPaths).toEqual([]);

  await page.goBack();
  await expect(drawer.getByRole('heading', { name: taskA.title })).toBeVisible();
  failTaskB = false;
  await page.goForward();
  await expect(drawer.getByRole('heading', { name: taskB.title })).toBeVisible();
  await drawer.getByRole('button', { name: '暂停自动维护' }).click();
  await expect(drawer.getByText('这项任务已暂停 AI 自动维护', { exact: true })).toBeVisible();
  expect(mutationPaths).toEqual([`/api/tasks/${taskB.id}/automation`]);
});

test('候选收件箱可以显示并接受需求', async ({ page }, testInfo) => {
  const marker = `${testInfo.project.name}-${testInfo.retry}-${Date.now().toString(36)}`;
  const created = await page.request.post('/api/dev/simulate-message', {
    data: {
      externalId: `e2e-candidate-accept-${marker}`,
      sourceType: 'owner_dm',
      conversationId: `e2e-candidate-accept-${marker}`,
      senderId: 'e2e-candidate-accept-requester',
      senderName: 'E2E 候选提出人',
      content: `E2E-${marker}：请分析活动参与和留存，并建立一项待确认任务。`,
      occurredAt: new Date().toISOString(),
      completeness: 'complete',
      discoveryReason: 'E2E 验证候选接受流程。',
    },
  });
  expect(created.ok()).toBeTruthy();
  const body = await created.json() as { candidate: { id: string; title: string } | null };
  expect(body.candidate).not.toBeNull();

  await page.goto('/candidates');
  await expect(page.getByRole('heading', { name: '候选收件箱' })).toBeVisible();
  const candidateCard = candidateCardById(page, body.candidate!.id);
  await expect(candidateCard).toBeVisible();
  await candidateCard.getByRole('button', { name: '接受为正式任务' }).click();
  await expect(page.getByText(/已建立正式任务/)).toBeVisible();
});

test('浏览器候选收件箱支持 seed 创建、接受、暂存和忽略', async ({ page }, testInfo) => {
  const acceptedTitle = '浏览器接受候选';
  const snoozedTitle = '浏览器暂存候选';
  const ignoredTitle = '浏览器忽略候选';
  const acceptedId = await seedPendingCandidate(page, acceptedTitle);
  const snoozedId = await seedPendingCandidate(page, snoozedTitle);
  const ignoredId = await seedPendingCandidate(page, ignoredTitle);

  await page.goto('/candidates');
  await expect(page.getByRole('heading', { name: '候选收件箱' })).toBeVisible();
  await expect(page.getByRole('button', { name: '模拟一条需求（浏览器测试）' })).toHaveCount(0);
  const filterBar = page.locator('.filter-bar');

  await candidateCardById(page, acceptedId).getByRole('button', { name: '接受为正式任务' }).click();
  await expect(page.getByText(`已建立正式任务：${acceptedTitle}`, { exact: true })).toBeVisible();
  await filterBar.getByRole('button', { name: '已接受', exact: true }).click();
  await expect(candidateCardById(page, acceptedId).getByText('已接受', { exact: true })).toBeVisible();

  await filterBar.getByRole('button', { name: '待确认', exact: true }).click();
  await candidateCardById(page, snoozedId).getByRole('button', { name: '稍后再议' }).click();
  await expect(page.getByText('已放入稍后再议。', { exact: true })).toBeVisible();
  await filterBar.getByRole('button', { name: '稍后再议', exact: true }).click();
  await expect(candidateCardById(page, snoozedId).locator('.status-text').getByText('稍后再议', { exact: true })).toBeVisible();

  await filterBar.getByRole('button', { name: '待确认', exact: true }).click();
  await candidateCardById(page, ignoredId).getByRole('button', { name: '忽略' }).click();
  await expect(page.getByText('已忽略这条候选。', { exact: true })).toBeVisible();
  await filterBar.getByRole('button', { name: '已忽略', exact: true }).click();
  await expect(candidateCardById(page, ignoredId).locator('.status-text').getByText('已忽略', { exact: true })).toBeVisible();
});

test('设置页开发者工具可添加测试用模拟需求，并在 seed 接口缺失时回退到补录接口', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: testInfo.testId,
      consoleText: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
      method: 'POST',
      pathname: '/api/dev/seed-intake',
      search: '',
      status: 404,
      expectedCount: 1,
    }),
  });
  let seedCalls = 0;
  let fallbackCalls = 0;
  await page.route('**/api/dev/seed-intake', async (route) => {
    seedCalls += 1;
    expect(route.request().method()).toBe('POST');
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
  });
  await page.route('**/api/corrections', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    fallbackCalls += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      correctionType: 'missed_request',
      manualContent: '浏览器测试用的模拟需求：请核对候选收件箱是否能接收新内容。',
      manualSenderName: '浏览器测试需求方',
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ duplicate: false, candidate: null, task: null, targetTask: null }) });
  });

  await page.goto('/settings');
  const seedButton = page.getByRole('button', { name: '模拟一条需求（浏览器测试）' });
  await expect(seedButton).toBeVisible();
  await seedButton.click();
  await expect(page.getByText('模拟需求已加入候选收件箱。', { exact: true })).toBeVisible();
  expect(seedCalls).toBe(1);
  expect(fallbackCalls).toBe(1);
});

test('设置页开发者工具生成模拟需求后，候选收件箱显示新增候选', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: '模拟一条需求（浏览器测试）' }).click();
  await expect(page.getByText('模拟需求已加入候选收件箱。', { exact: true })).toBeVisible();
  await page.goto('/candidates');
  await expect(page.getByRole('heading', { name: '浏览器测试用的模拟需求', exact: true })).toBeVisible();
});

test('候选 mutation 已成功但刷新失败时保留 canonical 状态并禁止继续操作', async ({ page }) => {
  const candidate = {
    id: 'e2e-data03-refresh-failure', version: 1, source_event_id: 'e2e-data03-source',
    title: 'DATA-03 合成候选', proposer_name: '合成需求方', background: '合成背景',
    validation_question: '合成验证', describe: '合成描述', confidence: 0.9, state: 'pending',
    snoozed_until: null, accepted_task_id: null, deleted_at: null,
    created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z',
    source_type: 'owner_dm', owner_mentioned: 0, source_completeness: 'complete',
    discovery_reason: '合成测试', processing_state: 'ready', processing_error: null,
    context_state: 'complete', context_reason: null, recovered_at: null,
    thread_association: null, merge_group: null,
    analysis: {
      timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
      fieldBasis: { background: 'fact', validationQuestion: 'fact', describe: 'fact' },
      recognitionEvidence: [], linkedDocuments: [], sourceRevision: null, contextRevision: null,
    },
  };
  let candidateLoads = 0;
  await page.route('**/api/source-failures**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await page.route('**/api/candidates**', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.continue();
    candidateLoads += 1;
    if (candidateLoads === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [candidate], ownerActions: [] }) });
      return;
    }
    // A malformed successful response exercises the refresh-failure path
    // without producing a browser-level HTTP console error.
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'not-json' });
  });
  await page.route('**/api/candidates/*/action', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ action: 'snooze', expectedVersion: 1 });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ candidate: { ...candidate, version: 2, state: 'snoozed', snoozed_until: '2026-08-17T00:00:00.000Z' }, task: null }),
    });
  });

  await page.goto('/candidates');
  await expect(page.getByRole('heading', { name: '候选收件箱' })).toBeVisible();
  await page.getByRole('button', { name: '全部' }).click();
  const card = page.locator('article.candidate-card').filter({ hasText: candidate.title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '稍后再议' }).click();
  await expect(page.getByText('写入已成功，但列表未刷新', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '稍后再议' })).toBeDisabled();
  expect(candidateLoads).toBe(2);
});

test('Issue #57 候选文档外链只打开允许目标，并在拒绝时显示脱敏反馈', async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __openedExternal?: string }).open = ((url?: string | URL) => {
      (window as typeof window & { __openedExternal?: string }).__openedExternal = String(url ?? '');
      return window;
    }) as typeof window.open;
  });
  await page.route('**/api/candidates**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/candidates' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [issue57Candidate], ownerActions: [] }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/candidates');
  const card = candidateCardById(page, issue57Candidate.id);
  await expect(card.getByText('关联的文档背景')).toBeVisible();
  await expect(card.getByText('已读取')).toBeVisible();
  await expect(card.getByText('当前类型暂未读取')).toBeVisible();
  await expect(card.locator('button.candidate-document-link')).toHaveCount(0);
  await expect(card).not.toContainText('tenant.feishu.cn');
  await expect(card).not.toContainText('synthetic-url-secret-57');
});

test('候选页重新获得焦点会刷新后台新候选，并可从候选卡发起来源重试', async ({ page }) => {
  let candidateLoads = 0;
  let retryCalls = 0;
  const sourceScope = 'src_scope_0123456789abcdef0123456789abcdef';
  const pendingCandidate = {
    id: 'e2e-retry-candidate',
    version: 1,
    title: 'E2E 自动恢复候选',
    proposer_name: 'E2E 需求方',
    background: '验证候选页能够显示后台整理状态。',
    validation_question: '是否能自动恢复？',
    describe: '验证来源分类重试和候选页刷新。',
    confidence: 0.88,
    state: 'pending',
    snoozed_until: null,
    accepted_task_id: null,
    deleted_at: null,
    created_at: '2026-08-13T08:00:00.000Z',
    updated_at: '2026-08-13T08:00:00.000Z',
    source_type: 'owner_dm',
    source_scope: sourceScope,
    owner_mentioned: 0,
    source_completeness: 'complete',
    discovery_reason: 'E2E 测试来源',
    processing_state: 'retry_waiting',
    processing_error: '模型结构校验暂未通过，等待自动重试。',
    context_state: 'complete',
    context_reason: null,
    recovered_at: null,
    analysis: {
      timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
      fieldBasis: { background: 'fact', validationQuestion: 'fact', describe: 'fact' },
      recognitionEvidence: ['E2E 测试识别依据'],
      linkedDocuments: [],
      sourceRevision: null,
      contextRevision: null,
    },
  };
  let currentCandidate = pendingCandidate;

  await page.route('**/api/candidates**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/candidates' && request.method() === 'GET') {
      candidateLoads += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: candidateLoads === 1 ? [] : [currentCandidate] }) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/candidates/**/source-retry', async (route) => {
    retryCalls += 1;
    expect(route.request().postDataJSON()).toEqual({ sourceScope, expectedVersion: 1 });
    currentCandidate = {
      ...currentCandidate,
      processing_state: 'recovered',
      processing_error: null,
      recovered_at: '2026-08-13T08:05:00.000Z',
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'queued', message: '已加入 AI 自动重试队列。' }) });
  });

  await page.goto('/candidates');
  await expect(page.getByRole('heading', { name: '候选收件箱' })).toBeVisible();
  await expect.poll(() => candidateLoads).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const card = candidateCardById(page, pendingCandidate.id);
  await expect(card).toBeVisible();
  await expect(card.getByText('等待自动重试', { exact: true })).toBeVisible();

  await card.getByRole('button', { name: '重新尝试整理' }).click();
  await expect(page.getByText('已加入 AI 自动重试队列。')).toBeVisible();
  await expect(card.getByText('已自动恢复', { exact: true })).toBeVisible();
  expect(retryCalls).toBe(1);
  expect(candidateLoads).toBe(3);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('失败来源收件箱不展示正文，重试后显示恢复结果', async ({ page }) => {
  let retryCalls = 0;
  let resolved = false;
  const failure = {
    id: 'e2e-source-failure-46', source_event_id: 'internal-source-46', source_type: 'owner_dm',
    occurred_at: '2026-08-16T01:00:00.000Z', stage: 'classification', error_code: 'MODEL_OUTPUT_INVALID',
    error_message: '模型输出未通过结构校验，来源已保留，等待安全重试。', status: 'open', retryable: true, stale: false,
    attempts: 3, max_attempts: 3, job_status: 'failed', next_retry_at: null,
    first_failed_at: '2026-08-16T01:01:00.000Z', last_failed_at: '2026-08-16T01:02:00.000Z', resolved_at: null, ignored_at: null,
    updated_at: '2026-08-16T01:02:00.000Z',
  };
  const candidate = {
    id: 'e2e-recovered-candidate-46', source_event_id: 'internal-source-46', title: '恢复后的活动留存分析', proposer_name: '合成需求方',
    background: '恢复后的安全摘要。', validation_question: '是否继续投入？', describe: '恢复后的候选。', confidence: 0.9,
    state: 'pending', snoozed_until: null, accepted_task_id: null, deleted_at: null,
    created_at: '2026-08-16T01:03:00.000Z', updated_at: '2026-08-16T01:03:00.000Z', source_type: 'owner_dm', owner_mentioned: 0,
    source_completeness: 'complete', discovery_reason: '合成失败来源恢复', processing_state: 'ready', processing_error: null,
    context_state: 'complete', context_reason: null, recovered_at: null, thread_association: null, merge_group: null,
    analysis: {
      timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
      fieldBasis: { background: 'fact', validationQuestion: 'fact', describe: 'fact' }, recognitionEvidence: ['合成恢复依据'], linkedDocuments: [],
    },
  };
  await page.route('**/api/source-failures**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: resolved ? [{ ...failure, status: 'resolved', retryable: false, resolved_at: '2026-08-16T01:04:00.000Z' }] : [failure] }) });
      return;
    }
    retryCalls += 1;
    resolved = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...failure, status: 'resolved', retryable: false, message: '失败来源已恢复，已生成候选。' }) });
  });
  await page.route('**/api/candidates**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: resolved ? [candidate] : [], ownerActions: [] }) });
  });

  await page.goto('/candidates');
  const inbox = page.getByRole('region', { name: '失败来源收件箱' });
  await expect(inbox).toBeVisible();
  await expect(inbox.getByText('阶段：AI 分类', { exact: true })).toBeVisible();
  await expect(inbox.getByText('MODEL_OUTPUT_INVALID', { exact: true })).toBeVisible();
  await expect(inbox.getByText('请整理活动留存数据并验证是否继续投入。', { exact: true })).toHaveCount(0);
  await inbox.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('失败来源已恢复，已生成候选。')).toBeVisible();
  await expect(page.getByText(candidate.title, { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '失败来源收件箱' }).getByText('查看已处理失败来源（1）', { exact: true })).toBeVisible();
  expect(retryCalls).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('AI 主人判断挂在对应候选卡片内，未关联判断才显示在顶部', async ({ page }) => {
  const candidate = {
    id: 'owner-action-card-candidate', source_event_id: 'owner-action-card-source', title: '活动埋点需求', proposer_name: 'E2E 需求方',
    background: '需要补齐活动埋点。', validation_question: '埋点方案是否完整？', describe: '整理并确认活动埋点需求。',
    confidence: 0.94, state: 'pending', snoozed_until: null, accepted_task_id: null, deleted_at: null,
    created_at: '2026-08-14T08:00:00.000Z', updated_at: '2026-08-14T08:00:00.000Z', source_type: 'owner_dm', owner_mentioned: 0,
    source_completeness: 'complete', discovery_reason: 'E2E 测试来源', processing_state: 'ready', processing_error: null,
    context_state: 'complete', context_reason: null, recovered_at: null, thread_association: null, merge_group: null,
    analysis: {
      timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
      fieldBasis: { background: 'fact', validationQuestion: 'fact', describe: 'fact' }, recognitionEvidence: ['存在明确的数据交付。'], linkedDocuments: [],
    },
  };
  const ownerActions = [
    { id: 'linked-action', action: 'confirm_schedule', state: 'review', candidateId: candidate.id, taskId: null, confidence: 0.96, scheduleDetected: true, createdAt: '2026-08-14T08:15:00.000Z', message: '主人动作已经识别，但未通过自动执行安全检查，等待主人确认。' },
    { id: 'unassigned-action', action: 'delegate', state: 'review', candidateId: null, taskId: null, confidence: 0.91, scheduleDetected: false, createdAt: '2026-08-14T08:20:00.000Z', message: '主人动作已经识别，但尚未安全关联到唯一候选，因此没有执行。' },
  ];
  await page.route('**/api/candidates**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/candidates' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [candidate], ownerActions }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/candidates');
  const card = candidateCardById(page, candidate.id);
  await expect(card.getByText('AI 判断（1）')).toBeVisible();
  await expect(card.getByText('未执行原因')).toBeHidden();
  await card.getByText('AI 判断（1）').click();
  await expect(card.getByText('确认时间', { exact: true })).toBeVisible();
  await expect(card.getByText('96%')).toBeVisible();
  await expect(card.getByText('已识别受控时间语义', { exact: false })).toBeVisible();
  await expect(card.getByText('下周三', { exact: false })).toHaveCount(0);
  await expect(card.getByText('未执行原因')).toBeVisible();
  await expect(page.getByLabel('尚未关联需求的主人动作')).toContainText('转交');
  await expect(page.getByText('聊天正文不应出现在这里')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('候选固定展示时间和四项解释，并如实显示飞书文档受限状态', async ({ page }) => {
  const marker = Date.now().toString(36);
  const created = await page.request.post('/api/dev/simulate-message', {
    data: {
      externalId: `e2e-candidate-evidence-${marker}`,
      sourceType: 'owner_dm',
      conversationId: `e2e-evidence-${marker}`,
      senderId: 'e2e-requester',
      senderName: 'E2E 需求方',
      content: `E2E-${marker}：请在下周三前分析活动留存，背景在 https://example.feishu.cn/docx/doc-${marker}`,
      occurredAt: '2026-08-11T04:00:00.000Z',
    },
  });
  const candidate = (await created.json()).candidate as { id: string; title: string };
  await page.goto('/candidates');
  expect(candidate.title).toContain(`E2E-${marker}`);
  const card = candidateCardById(page, candidate.id);
  await expect(card).toBeVisible();
  await expect(card).not.toContainText(`E2E-${marker}`);
  for (const label of ['时间范围', '背景', '希望验证', 'Describe', '为什么被识别']) {
    await expect(card.getByText(label, { exact: true })).toBeVisible();
  }
  const timeRange = card.locator('.candidate-facts > div').filter({ hasText: '时间范围' });
  await expect(timeRange).toContainText('2026/08/19');
  await expect(timeRange).not.toContainText('下周三');
  await expect(card.getByText('没有读取权限')).toBeVisible();
  await expect(card.getByText('关联的文档背景')).toBeVisible();
});

test('候选可以移入回收站、从回收站恢复，并回到原来的状态', async ({ page }) => {
  const marker = Date.now().toString(36);
  const created = await page.request.post('/api/dev/simulate-message', {
    data: {
      externalId: `e2e-candidate-trash-${marker}`,
      sourceType: 'owner_dm',
      conversationId: `e2e-candidate-trash-${marker}`,
      senderId: 'e2e-candidate-trash-requester',
      senderName: 'E2E 候选提出人',
      content: `E2E-${marker}：请分析活动参与和留存，先作为候选需求等待确认。`,
      occurredAt: new Date().toISOString(),
      completeness: 'complete',
      discoveryReason: 'E2E 验证候选回收站流程。',
    },
  });
  expect(created.ok()).toBeTruthy();
  const body = await created.json() as { candidate: { id: string; title: string } | null };
  expect(body.candidate).not.toBeNull();
  const candidate = body.candidate!;

  await page.goto('/candidates');
  const card = candidateCardById(page, candidate.id);
  await expect(card).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: '移入回收站' }).click();
  await expect(page.getByText('候选已移入回收站。')).toBeVisible();
  await expect(card).toHaveCount(0);

  await page.locator('.filter-bar').getByRole('button', { name: '回收站', exact: true }).click();
  const trashedCard = candidateCardById(page, candidate.id);
  await expect(trashedCard).toBeVisible();
  await expect(trashedCard.getByRole('button', { name: '恢复候选' })).toBeVisible();
  await expect(trashedCard.getByRole('button', { name: '接受为正式任务' })).toHaveCount(0);
  await trashedCard.getByRole('button', { name: '恢复候选' }).click();
  await expect(page.getByText('候选已恢复到原来的状态。')).toBeVisible();
  await expect(trashedCard).toHaveCount(0);

  await page.getByRole('button', { name: '待确认' }).click();
  const restoredCard = candidateCardById(page, candidate.id);
  await expect(restoredCard).toBeVisible();
  await expect(restoredCard.getByRole('button', { name: '移入回收站' })).toBeVisible();
});

test('候选操作按钮在桌面和窄屏保持可读且不产生横向溢出', async ({ page }) => {
  const marker = Date.now().toString(36);
  const created = await page.request.post('/api/dev/simulate-message', {
    data: {
      externalId: `e2e-candidate-layout-${marker}`,
      sourceType: 'owner_dm',
      conversationId: `e2e-candidate-layout-${marker}`,
      senderId: 'e2e-candidate-layout-requester',
      senderName: 'E2E 布局提出人',
      content: `E2E-${marker}：请分析活动参与和留存，候选卡需要保持按钮可操作。`,
      occurredAt: new Date().toISOString(),
      completeness: 'complete',
    },
  });
  expect(created.ok()).toBeTruthy();
  const body = await created.json() as { candidate: { id: string; title: string } | null };
  expect(body.candidate).not.toBeNull();

  await page.goto('/candidates');
  const card = candidateCardById(page, body.candidate!.id);
  await expect(card).toBeVisible();
  const actions = card.locator('.candidate-actions');
  await expect(actions).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const layout = await actions.evaluate((node) => {
    const style = getComputedStyle(node);
    return { display: style.display, columns: style.gridTemplateColumns };
  });
  if (await page.evaluate(() => window.innerWidth <= 640)) {
    expect(layout.display).toBe('grid');
    expect(layout.columns.split(' ').length).toBe(1);
  } else {
    expect(layout.display).toBe('flex');
  }

  await card.getByRole('button', { name: '忽略' }).click();
  await page.getByRole('button', { name: '已忽略', exact: true }).click();
  const ignoredCard = candidateCardById(page, body.candidate!.id);
  await expect(ignoredCard).toBeVisible();
  const restoreButton = ignoredCard.getByRole('button', { name: '恢复到稍后再议' });
  await expect(restoreButton).toBeVisible();
  const restoreBox = await restoreButton.boundingBox();
  const cardBox = await ignoredCard.boundingBox();
  expect(restoreBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(restoreBox!.y).toBeGreaterThan(cardBox!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('Issue #11 两个候选的重新整理指导语互不串用', async ({ page }) => {
  const marker = Date.now().toString(36);
  const createCandidate = async (suffix: string) => {
    const response = await page.request.post('/api/dev/simulate-message', {
      data: {
        externalId: `e2e-guidance-${marker}-${suffix}`,
        sourceType: 'owner_dm',
        conversationId: `e2e-guidance-${marker}-${suffix}`,
        senderId: `e2e-guidance-requester-${suffix}`,
        senderName: `E2E 指导语提出人 ${suffix}`,
        content: `E2E-${marker}-${suffix}：请分析活动参与和留存。`,
        occurredAt: new Date().toISOString(),
        completeness: 'complete',
      },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json() as { candidate: { id: string; title: string } | null };
    expect(body.candidate).not.toBeNull();
    return body.candidate!;
  };

  const first = await createCandidate('A');
  const second = await createCandidate('B');
  await page.goto('/candidates');
  const firstCard = candidateCardById(page, first.id);
  const secondCard = candidateCardById(page, second.id);

  await firstCard.getByRole('button', { name: '纠正判断' }).click();
  await firstCard.locator('.correction-guidance').fill('只补充第一个候选的背景。');
  await secondCard.getByRole('button', { name: '纠正判断' }).click();
  await secondCard.locator('.correction-guidance').fill('只补充第二个候选的验证问题。');
  await firstCard.getByRole('button', { name: '纠正判断' }).click();

  await expect(firstCard.locator('.correction-guidance')).toHaveValue('只补充第一个候选的背景。');
  await expect(secondCard.locator('.correction-guidance')).toHaveCount(0);
  await secondCard.getByRole('button', { name: '纠正判断' }).click();
  await expect(secondCard.locator('.correction-guidance')).toHaveValue('只补充第二个候选的验证问题。');
  await expect(firstCard.locator('.correction-guidance')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('Issue #13 自动归并只显示主体卡，并可更换主体和拆分来源', async ({ page }) => {
  const analysisId = 'issue13-analysis';
  const processId = 'issue13-process';
  const baseAnalysis = {
    timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
    fieldBasis: { background: 'fact', validationQuestion: 'inferred', describe: 'fact' },
    recognitionEvidence: ['消息明确提出统计提交次数并输出结论。'],
    ownerAction: { required: true, summary: '分析众筹箱功能提交次数并输出结论', role: 'analyze', basis: 'fact', confidence: 0.99 },
    linkedDocuments: [], sourceRevision: 'source-v1', contextRevision: 'context-v1',
  };
  const makeCandidate = (id: string, title: string, describe: string) => ({
    id, source_event_id: `source-${id}`, title, proposer_name: 'E2E 需求方', background: '924 版本需求接入背景。',
    validation_question: '近几个版本提交次数如何变化？', describe, confidence: 0.98, state: 'pending', snoozed_until: null,
    accepted_task_id: null, deleted_at: null, created_at: '2026-08-13T02:00:00.000Z', updated_at: '2026-08-13T02:00:00.000Z',
    source_type: 'owner_dm', owner_mentioned: 0, source_completeness: 'complete', discovery_reason: 'E2E Issue #13。',
    ai_reason: '消息明确提出数据分析。', analysis: baseAnalysis, thread_association: null, merge_group: null,
  });
  const analysis = makeCandidate(analysisId, '众筹箱功能提交次数分析', '统计近 3 到 4 个版本每周提交量并输出结论。');
  const process = makeCandidate(processId, '924版本看板与埋点需求流程咨询', '说明需求接入流程。');
  let primaryId = analysisId;
  let split = false;
  const mergedView = () => {
    const primary = primaryId === analysisId ? analysis : process;
    const sources = [
      {
        sourceEventId: `source-${processId}`, externalId: 'message-process', sourceType: 'owner_dm', senderName: 'E2E 需求方',
        content: '想咨询一下 924 版本看板与埋点需求应该走什么提需流程。', occurredAt: '2026-08-13T01:00:00.000Z',
        relationType: 'candidate_auto_merge', confidence: 0.98, role: primaryId === processId ? 'owner_delivery' : 'process_question',
        roleReason: primaryId === processId ? '系统主人将这条设为主体。' : '这是具体分析任务的流程背景。', candidateId: processId,
        title: process.title, isPrimary: primaryId === processId,
      },
      {
        sourceEventId: `source-${analysisId}`, externalId: 'message-analysis', sourceType: 'owner_dm', senderName: 'E2E 需求方',
        content: '请分析众筹箱功能提交次数，统计近 3 到 4 个版本每周提交量并输出结论。', occurredAt: '2026-08-13T01:05:42.000Z',
        relationType: 'candidate_auto_merge', confidence: 0.98, role: primaryId === analysisId ? 'owner_delivery' : 'background',
        roleReason: primaryId === analysisId ? '这是系统主人需要完成的具体数据交付。' : '系统主人将另一条来源设为主体。', candidateId: analysisId,
        title: analysis.title, isPrimary: primaryId === analysisId,
      },
    ];
    return {
      ...primary,
      merge_group: {
        threadId: 'issue13-thread', threadVersion: 3, sourceCount: 2, candidateCount: 2, primaryCandidateId: primaryId,
        primarySourceEventId: `source-${primaryId}`, primaryTitle: primary.title,
        primaryReason: primaryId === analysisId ? '具体分析和结论是系统主人需要推进的主体。' : '系统主人明确更换了主体任务。',
        primaryConfidence: primaryId === analysisId ? 0.99 : 1, suggestion: null, sources,
      },
    };
  };

  await page.route('**/api/candidates**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON?.() as Record<string, unknown> | null;
    if (url.pathname === '/api/candidates' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: split ? [analysis, process] : [mergedView()] }) });
      return;
    }
    if (url.pathname.endsWith('/merge/primary') && method === 'POST') {
      primaryId = String(body?.primaryCandidateId ?? primaryId);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidate: mergedView(), mergeGroup: mergedView().merge_group }) });
      return;
    }
    if (url.pathname.endsWith('/merge/split') && method === 'POST') {
      split = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ splitCandidate: analysis, remainingCandidate: process }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/candidates');
  await expect(page.locator('article.candidate-card')).toHaveCount(1);
  await expect(page.getByText('已合并 2 条候选消息')).toBeVisible();
  await expect(page.getByText('我需要推进', { exact: true })).toBeVisible();
  const card = page.locator('article.candidate-card');
  await card.getByText('查看 2 条来源摘要并纠正').click();
  await expect(card.getByText('流程咨询', { exact: true })).toBeVisible();
  await expect(card.getByText('你要推进的主体', { exact: true })).toBeVisible();
  await expect(card.getByText('想咨询一下 924 版本看板与埋点需求应该走什么提需流程。')).toHaveCount(0);
  await expect(card.getByText('请分析众筹箱功能提交次数，统计近 3 到 4 个版本每周提交量并输出结论。')).toHaveCount(0);
  await expect(card.getByText('聊天正文保留在本地审计记录中，这里只展示 AI 摘要和归类依据。')).toBeVisible();
  await card.locator('.candidate-merge-source').filter({ hasText: process.title }).getByRole('button', { name: '设为主体' }).click();
  await expect(page.getByText('已更换这项需求中你需要推进的主体任务。')).toBeVisible();
  const changed = candidateCardById(page, process.id);
  await changed.getByText('查看 2 条来源摘要并纠正').click();
  page.once('dialog', (dialog) => dialog.accept());
  await changed.locator('.candidate-merge-source').filter({ hasText: analysis.title }).getByRole('button', { name: '拆成独立候选' }).click();
  await expect(page.getByText('已拆成独立候选；两项需求可以分别处理。')).toBeVisible();
  await expect(page.locator('article.candidate-card')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('Issue #13 低置信建议必须确认，也可明确保留为两件事', async ({ page }) => {
  const targetId = 'issue13-suggestion-target';
  const currentId = 'issue13-suggestion-current';
  const analysis = {
    timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
    fieldBasis: { background: 'fact', validationQuestion: 'inferred', describe: 'fact' }, recognitionEvidence: ['测试来源'], linkedDocuments: [],
    sourceRevision: 'source-v1', contextRevision: 'context-v1',
  };
  const candidate = (id: string, title: string) => ({
    id, source_event_id: `source-${id}`, title, proposer_name: 'E2E 需求方', background: '需求背景', validation_question: '需要验证什么？',
    describe: title, confidence: 0.9, state: 'pending', snoozed_until: null, accepted_task_id: null, deleted_at: null,
    created_at: '2026-08-13T03:00:00.000Z', updated_at: '2026-08-13T03:00:00.000Z', source_type: 'owner_dm', source_completeness: 'complete',
    discovery_reason: 'E2E Issue #13 低置信建议。', ai_reason: '消息可能是需求。', analysis, thread_association: null,
    merge_group: { threadId: `thread-${id}`, threadVersion: 1, sourceCount: 1, candidateCount: 1, primaryCandidateId: id, primarySourceEventId: `source-${id}`, primaryTitle: title, primaryReason: '当前候选暂作为主体。', primaryConfidence: 0.9, suggestion: null, sources: [] },
  });
  const target = candidate(targetId, '924版本看板与埋点需求流程咨询');
  const current = candidate(currentId, '众筹箱功能提交次数分析');
  let rejected = false;
  current.merge_group.suggestion = {
    suggestionId: 'issue13-suggestion',
    targetCandidateId: targetId, targetThreadId: `thread-${targetId}`, confidence: 0.82, primary: 'current', primaryConfidence: 0.84,
    currentRole: 'owner_delivery', targetRole: 'process_question', reason: '业务对象接近，但证据不足以自动归并。', evidence: ['同一会话'],
    candidateSetHash: 'issue13-set', target: { candidateId: targetId, title: target.title, proposerName: 'E2E 需求方', occurredAt: '2026-08-13T02:55:00.000Z' },
  };

  await page.route('**/api/candidates**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/candidates' && request.method() === 'GET') {
      const currentView = { ...current, merge_group: { ...current.merge_group, suggestion: rejected ? null : current.merge_group.suggestion } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [currentView, target] }) });
      return;
    }
    if (url.pathname.endsWith('/merge/reject') && request.method() === 'POST') {
      rejected = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidate: current, targetCandidate: target, separateCandidates: true }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/candidates');
  const card = candidateCardById(page, current.id);
  await expect(card.getByLabel('候选归并建议')).toBeVisible();
  await expect(card.getByText(`已有候选：${target.title}`)).toBeVisible();
  await expect(card.getByRole('button', { name: '接受为正式任务' })).toBeDisabled();
  await card.getByRole('button', { name: '保留为两件事' }).click();
  await expect(page.getByText('已保留为两件独立需求，原始消息和判断记录仍然保留。')).toBeVisible();
  await expect(card.getByLabel('候选归并建议')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '接受为正式任务' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('候选任务可以安排私人计划、删除并从回收站恢复', async ({ page }, testInfo) => {
  const marker = Date.now().toString(36);
  const captured = await page.request.post('/api/dev/simulate-message', {
    data: {
      externalId: `e2e-task-lifecycle-${marker}`,
      sourceType: 'owner_dm',
      conversationId: `e2e-conversation-${marker}`,
      senderId: 'e2e-requester',
      senderName: 'E2E 测试提出人',
      content: `E2E-${marker}：请用数据分析活动参与和留存，并整理成一个待确认任务。`,
      occurredAt: new Date().toISOString(),
      completeness: 'complete',
      discoveryReason: 'E2E 验证个人信息来源进入统一候选链。',
    },
  });
  expect(captured.ok()).toBeTruthy();
  const capturedBody = await captured.json() as { candidate: { id: string; title: string } | null };
  expect(capturedBody.candidate).not.toBeNull();
  const candidate = capturedBody.candidate!;

  await page.goto('/candidates');
  const candidateCard = candidateCardById(page, candidate.id);
  await expect(candidateCard).toBeVisible();
  await candidateCard.getByRole('button', { name: '接受为正式任务' }).click();
  await expect(page.getByText(/已建立正式任务/)).toBeVisible();

  let taskId = '';
  await expect.poll(async () => {
    const response = await page.request.get('/api/candidates');
    const body = await response.json() as { items: Array<{ id: string; accepted_task_id: string | null }> };
    taskId = body.items.find((item) => item.id === candidate.id)?.accepted_task_id ?? '';
    return taskId;
  }).not.toBe('');

  const beforeDetail = await (await page.request.get(`/api/tasks/${taskId}`)).json() as { approvals: unknown[]; title: string };
  const approvalCount = beforeDetail.approvals.length;
  const taskTitle = beforeDetail.title;

  await page.goto(`/tasks?task=${taskId}`);
  await expect(page.getByRole('heading', { name: taskTitle })).toBeVisible();
  await page.getByLabel('计划开始').fill('2030-06-15T09:30');
  await page.getByLabel('计划完成').fill('2030-06-15T11:00');
  await page.getByRole('button', { name: '保存我的计划' }).click();
  await expect(page.getByText('我的计划时间已保存；这只是私人安排，不代表对外承诺。')).toBeVisible();

  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const taskRow = page.getByRole('row')
    .filter({ has: page.getByText(taskTitle, { exact: true }) })
    .filter({ has: page.getByText('已排期', { exact: true }) });
  await expect(taskRow).toContainText('→');

  await page.goto('/calendar');
  await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();

  await page.goto(`/tasks?task=${taskId}`);
  await page.getByRole('button', { name: '清除安排' }).click();
  await expect(page.getByText('我的计划时间已清除；没有向需求方发送任何内容。')).toBeVisible();
  await page.goto('/calendar');
  await expect(page.getByText(taskTitle, { exact: true })).toHaveCount(0);

  await page.goto(`/tasks?task=${taskId}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除任务' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  const activeTasksAfterDelete = await (await page.request.get('/api/tasks')).json() as { items: Array<{ id: string }> };
  expect(activeTasksAfterDelete.items.some((item) => item.id === taskId)).toBe(false);

  await page.goto('/archive');
  await page.getByRole('button', { name: /回收站/ }).click();
  await page.getByRole('row').filter({ hasText: taskTitle }).click();
  const trashedTaskDetail = page.getByLabel('任务详情', { exact: true });
  await expect(trashedTaskDetail.getByText('这项任务位于回收站。日常列表、工作台、排期和提醒已经停止显示；来源与审计仍保留。')).toBeVisible();
  const trashedTaskResponse = await page.request.get(`/api/tasks/${taskId}`);
  expect(trashedTaskResponse.ok()).toBeTruthy();
  const trashedTaskBody = await trashedTaskResponse.json() as { proposer_name: string };
  expect(trashedTaskBody.proposer_name).toBe('需求方');
  await expect(trashedTaskDetail.getByText('E2E 测试提出人', { exact: true })).toHaveCount(0);
  await trashedTaskDetail.getByRole('button', { name: '恢复任务' }).click();
  await expect(page.getByText('任务和对应的已接受候选已同时恢复；此前作废的对外草稿不会自动恢复。')).toBeVisible();

  await page.goto('/candidates');
  await page.getByRole('button', { name: '已接受', exact: true }).click();
  const acceptedCard = candidateCardById(page, candidate.id);
  await expect(acceptedCard).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await acceptedCard.getByRole('button', { name: '移入回收站' }).click();
  await expect(page.getByText('候选和正式任务已同时移入回收站。')).toBeVisible();
  expect((await (await page.request.get(`/api/tasks/${taskId}`)).json() as { deleted_at: string | null }).deleted_at).not.toBeNull();

  await page.getByRole('button', { name: '回收站', exact: true }).click();
  const linkedTrashCard = candidateCardById(page, candidate.id);
  await expect(linkedTrashCard.getByText('对应正式任务也已同步进入回收站')).toBeVisible();
  await linkedTrashCard.getByRole('button', { name: '恢复候选和任务' }).click();
  await expect(page.getByText('候选和正式任务已同时恢复。')).toBeVisible();

  const afterDetail = await (await page.request.get(`/api/tasks/${taskId}`)).json() as {
    approvals: unknown[];
    deleted_at: string | null;
    planned_start_at: string | null;
    planned_due_at: string | null;
  };
  expect(afterDetail.approvals).toHaveLength(approvalCount);
  expect(afterDetail.deleted_at).toBeNull();
  expect(afterDetail.planned_start_at).toBeNull();
  expect(afterDetail.planned_due_at).toBeNull();
});

test('同一需求可持续补充，拒绝不改任务，确认后版本和任务记忆同步更新', async ({ page }, testInfo) => {
  const marker = Date.now().toString(36);
  const conversationId = `e2e-thread-${marker}`;
  const send = async (suffix: string, content: string) => {
    const response = await page.request.post('/api/dev/simulate-message', {
      data: {
        externalId: `e2e-thread-${marker}-${suffix}`,
        sourceType: 'owner_dm',
        conversationId,
        senderId: 'e2e-thread-requester',
        senderName: 'E2E 持续需求方',
        content,
        occurredAt: new Date().toISOString(),
        completeness: 'complete',
        discoveryReason: 'E2E 验证同一需求的持续更新。',
        metadata: suffix === 'initial' ? undefined : { parentId: `e2e-thread-${marker}-initial` },
      },
    });
    expect(response.ok()).toBeTruthy();
    return response.json() as Promise<{ candidate: { id: string; title: string; accepted_task_id: string | null } | null }>;
  };

  const initial = await send('initial', `E2E-${marker}：请用数据验证活动参与和留存，并建立一项正式任务。`);
  expect(initial.candidate).not.toBeNull();
  await page.goto('/candidates');
  const initialCard = candidateCardById(page, initial.candidate!.id);
  await expect(initialCard).toBeVisible();
  await initialCard.getByRole('button', { name: '接受为正式任务' }).click();
  await expect(page.getByText(/已建立正式任务/)).toBeVisible();

  let taskId = '';
  await expect.poll(async () => {
    const candidates = await (await page.request.get('/api/candidates')).json() as { items: Array<{ id: string; accepted_task_id: string | null }> };
    taskId = candidates.items.find((item) => item.id === initial.candidate!.id)?.accepted_task_id ?? '';
    return taskId;
  }).not.toBe('');
  const before = await (await page.request.get(`/api/tasks/${taskId}`)).json() as {
    version: number;
    memory_projection: { state: string; projection_version: number };
  };
  expect(before.memory_projection).toMatchObject({ state: 'ready', projection_version: before.version });

  await send('rejected', `补充：E2E-${marker} 请继续用数据分析付费维度，计划在2030年8月15日前完成。`);
  await expect.poll(async () => {
    const detail = await (await page.request.get(`/api/tasks/${taskId}`)).json() as { update_proposals: Array<{ state: string }> };
    return detail.update_proposals.filter((proposal) => proposal.state === 'awaiting_approval').length;
  }).toBe(1);
  await page.goto(`/tasks?task=${taskId}`);
  await page.getByRole('button', { name: /持续更新/ }).click();
  const rejectedProposal = page.locator('article.proposal-awaiting_approval');
  await expect(rejectedProposal).toHaveCount(1);
  await rejectedProposal.getByRole('button', { name: '拒绝这条更新' }).click();
  await expect(page.getByText('这条后续更新已拒绝；正式任务、需求线程和任务记忆保持原样。')).toBeVisible();
  const afterReject = await (await page.request.get(`/api/tasks/${taskId}`)).json() as {
    version: number;
    memory_projection: { state: string; projection_version: number };
  };
  expect(afterReject.version).toBe(before.version);
  expect(afterReject.memory_projection.projection_version).toBe(before.memory_projection.projection_version);

  await send('approved', `补充：E2E-${marker} 请继续用数据分析设备维度，计划在2030年8月16日前完成。`);
  await expect.poll(async () => {
    const detail = await (await page.request.get(`/api/tasks/${taskId}`)).json() as { update_proposals: Array<{ state: string }> };
    return detail.update_proposals.filter((proposal) => proposal.state === 'awaiting_approval').length;
  }).toBe(1);
  await page.goto(`/tasks?task=${taskId}`);
  await page.getByRole('button', { name: /持续更新/ }).click();
  const approvedProposal = page.locator('article.proposal-awaiting_approval');
  await expect(approvedProposal).toHaveCount(1);
  await approvedProposal.getByRole('button', { name: '确认这条更新' }).click();
  await expect(page.getByText('后续更新已写入正式任务和需求线程，任务记忆也已刷新。')).toBeVisible();
  await expect.poll(async () => {
    const detail = await (await page.request.get(`/api/tasks/${taskId}`)).json() as {
      version: number;
      memory_projection: { state: string; projection_version: number };
    };
    return { version: detail.version, memoryState: detail.memory_projection.state, memoryVersion: detail.memory_projection.projection_version };
  }).toEqual({ version: before.version + 1, memoryState: 'ready', memoryVersion: before.version + 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CAPTURE_ISSUE9_QA) {
    await page.screenshot({ path: testInfo.outputPath('issue9-continuous-update.png'), fullPage: true });
  }
});

test('长更新、记忆失败与 Runtime 失败在桌面和手机端都可恢复且不横向溢出', async ({ page }, testInfo) => {
  const taskId = 'issue9-fixture-task';
  let memoryReady = false;
  let runtimeRetryCalls = 0;
  await page.addInitScript(() => {
    (window as any).__openedTaskMemory = '';
    (window as any).aiPmDesktop = {
      api: {
        request: async ({ method, url, body }: { method: string; url: string; body?: unknown }) => {
          const response = await fetch(url, {
            method,
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        },
      },
      app: { info: async () => ({ version: 'test', platform: 'win32', packaged: true }), relaunch: async () => undefined },
      config: { get: async () => ({ setupComplete: true }) },
      feishu: { authorize: async () => ({ opened: true }) },
      workspace: { pickDirectory: async () => null },
      taskMemory: { open: async (id: string) => { (window as any).__openedTaskMemory = id; return { opened: true }; } },
      diagnostics: { export: async () => ({ saved: false }) },
    };
  });

  const baseTask = {
    id: taskId,
    title: '超长持续更新与恢复状态验收',
    proposer_name: 'E2E 需求方',
    describe: '验证长内容在窄屏中不会撑破任务抽屉。',
    status: 'unplanned',
    schedule_at: null,
    planned_start_at: null,
    planned_due_at: null,
    next_step: '确认更新证据并恢复失败工作项。',
    risk: 'medium',
    waiting_reason: null,
    version: 3,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    record_state: 'active',
    merged_into_task_id: null,
    auto_update_paused: false,
    created_at: '2026-08-11T08:00:00.000Z',
    updated_at: '2026-08-11T09:00:00.000Z',
  };
  const detail = () => ({
    ...baseTask,
    sources: [{ id: 'source-fixture', source_type: 'owner_dm', sender_name: 'E2E 需求方', content: '一条已持久化的来源。', occurred_at: '2026-08-11T08:00:00.000Z' }],
    events: [],
    references: [],
    approvals: [],
    thread: { id: 'thread-fixture', status: 'needs_confirmation', title: baseTask.title, background: '这是一个很长的背景说明。'.repeat(35), validation_question: '如何验证长文本、失败状态和恢复入口在手机端仍然可读？', describe: baseTask.describe, version: 4, last_activity_at: '2026-08-11T09:00:00.000Z', ambiguity: [] },
    update_proposals: [{
      id: 'proposal-fixture', task_id: taskId, thread_id: 'thread-fixture', source_event_id: 'source-fixture', candidate_revision_id: 'candidate-revision-fixture', thread_revision_id: 'thread-revision-fixture',
      base_task_version: 3, base_thread_version: 4, patch: { describe: '需要保留证据和上下文。'.repeat(70), note: '这只是建议，必须由主人确认。' },
      changes: [{ field: 'describe', before: baseTask.describe, after: '需要保留证据和上下文。'.repeat(70) }],
      reason: '后续来源被判断为同一需求的补充，等待系统主人确认是否更新正式任务。', evidence: { relationType: 'owner_confirmed', confidence: 1, recognitionEvidence: ['来源包含明确的继续补充表达。'] },
      provider: 'e2e-provider', model: 'e2e-model', prompt_version: 'e2e-v1', state: 'awaiting_approval', origin: 'follow_up',
      association_confidence: 1, update_confidence: 0.82, used_fallback: false, decision_mode: 'pending', policy_version: 'issue11-v1', policy_reason: '字段修改置信度不足，等待主人确认。',
      applied_task_version: null, applied_thread_version: null, task_event_id: null, reverted_at: null, reverted_task_event_id: null,
      can_revert: false, cannot_revert_reason: '只有 AI 自动应用的更新可以一键撤销。',
      source: { id: 'source-fixture', source_type: 'owner_dm', sender_name: 'E2E 需求方', source_url: null, occurred_at: '2026-08-11T08:00:00.000Z' },
      created_at: '2026-08-11T09:00:00.000Z', decided_at: null,
    }],
    auto_updates: [],
    memory_projection: memoryReady
      ? { task_id: taskId, projection_version: 3, relative_path: 'tasks/issue9-fixture-task-memory', state: 'ready', last_error: null, last_projected_at: '2026-08-11T09:10:00.000Z', updated_at: '2026-08-11T09:10:00.000Z' }
      : { task_id: taskId, projection_version: 0, relative_path: 'tasks/issue9-fixture-task-memory', state: 'error', last_error: '任务记忆投影失败；本机路径已脱敏为 <local-path>。', last_projected_at: null, updated_at: '2026-08-11T09:00:00.000Z' },
    runtime_jobs: [{ id: 'runtime-failed', job_type: 'classify_source', status: 'failed', attempts: 3, max_attempts: 3, retryable: 0, available_at: '2026-08-11T09:00:00.000Z', last_error: '模型请求失败；URL 和 Token 已脱敏。', created_at: '2026-08-11T08:00:00.000Z', updated_at: '2026-08-11T09:00:00.000Z' }],
  });

  await page.route('**/api/runtime/jobs/runtime-failed/retry', async (route) => {
    runtimeRetryCalls += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'queued' }) });
  });
  await page.route('**/api/tasks**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/tasks/${taskId}/memory/project` && route.request().method() === 'POST') {
      memoryReady = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail().memory_projection) });
      return;
    }
    if (url.pathname === `/api/tasks/${taskId}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail()) });
      return;
    }
    if (url.pathname === '/api/tasks') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [baseTask] }) });
      return;
    }
    await route.continue();
  });

  await page.goto(`/#/tasks?task=${taskId}`);
  await page.getByRole('button', { name: /持续更新/ }).click();
  await expect(page.getByText('任务记忆投影失败；本机路径已脱敏为 <local-path>。')).toBeVisible();
  await expect(page.locator('article.proposal-awaiting_approval')).toContainText('需要保留证据和上下文');
  await page.getByRole('button', { name: '重试任务记忆' }).click();
  await expect(page.getByText('任务记忆已重新生成。')).toBeVisible();
  await page.getByRole('button', { name: '打开任务记忆目录' }).click();
  await expect(page.getByText('已在本机文件管理器中打开任务记忆目录。')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__openedTaskMemory)).toBe(taskId);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('Runtime 工作项已重新加入安全重试队列。')).toBeVisible();
  expect(runtimeRetryCalls).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CAPTURE_ISSUE9_QA) {
    await page.screenshot({ path: testInfo.outputPath(`issue9-recovery-${testInfo.project.name}.png`), fullPage: true });
  }
});

test('Issue #11 可编辑任务、监督 AI 修改、暂停维护并安全管理记忆和引用', async ({ page }, testInfo) => {
  const taskId = 'issue11-ui-fixture-task';
  const referenceId = 'issue11-reference';
  let automationPaused = false;
  let referencePresent = true;
  let memoryRebuilds = 0;
  let automationMode: 'auto' | 'suggest' = 'auto';
  let taskVersion = 4;
  let title = 'Issue #11 自动维护验收';
  let describe = 'AI 已根据强回复链补充任务背景。';
  let nextStep = '检查自动修改证据。';
  let risk = 'medium';
  let waitingReason: string | null = null;
  let status = 'in_progress';
  let plannedStartAt: string | null = null;
  let plannedDueAt: string | null = null;
  let autoReverted = false;
  let terminalWarning = false;
  let notificationRead = false;

  await page.addInitScript(() => {
    const desktopConfig = {
      setupComplete: true,
      launchAtLogin: false,
      logRetentionDays: 30,
      feishu: {
        appId: '', externalEnabled: false, domain: 'feishu', eventMode: 'websocket',
        oauthRedirectUri: 'http://127.0.0.1:4311/oauth/feishu/callback', oauthScopes: '',
        scanEnabled: false, scanIntervalSeconds: 60, groupIds: [],
      },
      llm: { provider: 'rule_mock', model: '', apiBase: '', timeoutMs: 30000, maxRetries: 2 },
      workspace: { readEnabled: false, allowedPaths: [] },
      secretState: { feishuAppSecret: false, feishuUserAccessToken: false, feishuRefreshToken: false, llmApiKey: false, feishuUserToken: false },
    };
    (window as any).aiPmDesktop = {
      api: {
        request: async ({ method, url, body }: { method: string; url: string; body?: unknown }) => {
          const response = await fetch(url, {
            method,
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        },
      },
      app: { info: async () => ({ version: 'test', platform: 'win32', packaged: true }), relaunch: async () => undefined },
      config: { get: async () => desktopConfig },
      feishu: { authorize: async () => ({ opened: true }) },
      workspace: { pickDirectory: async () => null },
      taskMemory: { open: async () => ({ opened: true }) },
      diagnostics: { export: async () => ({ saved: false }) },
    };
  });

  const autoProposal = () => ({
    id: 'issue11-auto-proposal', task_id: taskId, thread_id: 'issue11-thread', source_event_id: 'issue11-source', candidate_revision_id: 'issue11-candidate-revision', thread_revision_id: 'issue11-thread-revision',
    base_task_version: 3, base_thread_version: 2,
    patch: { status: terminalWarning ? 'completed' : 'in_progress', nextStep: '检查自动修改证据。' },
    changes: [
      { field: 'status', before: 'unplanned', after: terminalWarning ? 'completed' : 'in_progress' },
      { field: 'nextStep', before: '等待进一步说明。', after: '检查自动修改证据。' },
    ],
    reason: '明确回复链和双重置信度均通过安全门槛。',
    evidence: { relationType: 'reply_parent', recognitionEvidence: ['消息直接回复原需求。', '需求方明确要求开始推进。'] },
    provider: 'deepseek', model: 'deepseek-v4-flash', prompt_version: 'issue11-e2e-v1', state: 'approved', origin: 'follow_up',
    association_confidence: 0.99, update_confidence: 0.98, used_fallback: false,
    decision_mode: autoReverted ? 'reverted' : 'auto', policy_version: 'issue11-v1', policy_reason: '唯一强关联、模型未降级、双重置信度及版本门槛均通过。',
    applied_task_version: 4, applied_thread_version: 3, task_event_id: 'issue11-task-event',
    reverted_at: autoReverted ? '2026-08-12T13:10:00.000Z' : null, reverted_task_event_id: autoReverted ? 'issue11-revert-event' : null,
    can_revert: !autoReverted && taskVersion === 4,
    cannot_revert_reason: autoReverted ? '这次自动更新已经撤销。' : taskVersion === 4 ? null : '任务已有后续修改，不能覆盖新内容。',
    source: { id: 'issue11-source', source_type: 'owner_dm', sender_name: 'E2E 需求方', source_url: null, occurred_at: '2026-08-12T12:00:00.000Z' },
    created_at: '2026-08-12T12:00:10.000Z', decided_at: autoReverted ? '2026-08-12T13:10:00.000Z' : '2026-08-12T12:00:11.000Z',
  });

  const taskDetail = () => {
    const proposal = autoProposal();
    return {
      id: taskId, title, proposer_name: 'E2E 需求方', describe, status,
      schedule_at: plannedDueAt, planned_start_at: plannedStartAt, planned_due_at: plannedDueAt,
      next_step: nextStep, risk, waiting_reason: waitingReason, version: taskVersion,
      completed_at: null, archived_at: null, deleted_at: null, record_state: 'active', merged_into_task_id: null,
      auto_update_paused: automationPaused, created_at: '2026-08-12T11:00:00.000Z', updated_at: '2026-08-12T12:00:11.000Z',
      sources: [{ id: 'issue11-source', source_type: 'owner_dm', sender_name: 'E2E 需求方', content: '继续补充：现在开始推进，并检查设备维度。', occurred_at: '2026-08-12T12:00:00.000Z' }],
      events: [], approvals: [],
      references: referencePresent ? [{ id: referenceId, label: '分析工作目录', reference_path: 'workspace://issue11', access_mode: 'reference_only' }] : [],
      thread: { id: 'issue11-thread', status: 'open', title, background: '活动分析需求持续补充。', validation_question: '新增设备维度后结论是否稳定？', describe, version: 3, last_activity_at: '2026-08-12T12:00:00.000Z', ambiguity: [] },
      update_proposals: [proposal], auto_updates: [proposal],
      memory_projection: { task_id: taskId, projection_version: taskVersion, relative_path: 'tasks/issue11-auto-maintenance', state: 'ready', last_error: null, last_projected_at: '2026-08-12T12:00:12.000Z', updated_at: '2026-08-12T12:00:12.000Z' },
      runtime_jobs: [],
    };
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON?.() as Record<string, unknown> | null;

    if (url.pathname === '/api/automation-policy') {
      if (method === 'PATCH') automationMode = body?.mode === 'suggest' ? 'suggest' : 'auto';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: automationMode, associationThreshold: 0.92, updateThreshold: 0.9, policyVersion: 'issue11-v1', updatedAt: '2026-08-12T12:00:00.000Z' }) });
      return;
    }
    if (url.pathname === '/api/dashboard' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [], today: [], waiting: [], counts: { candidates: 0, today: 0, waiting: 0, inProgress: 0, overdue: 0 }, asOf: '2026-08-15T00:30:00.000Z', todayDate: '2026-08-15', timezone: 'Asia/Shanghai', dataMode: 'local_mock' }) });
      return;
    }
    if (url.pathname === '/api/notifications' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: notificationRead ? [] : [{
            id: 'issue11-notice',
            task_id: taskId,
            task_event_id: 'issue11-task-event',
            candidate_id: null,
            notification_type: 'immediate',
            dedupe_key: 'auto-update:issue11-auto-proposal',
            reason: 'AI 已自动维护私人任务；你可以查看证据或在没有后续修改时一键撤销。',
            read_at: null,
            snoozed_until: null,
            archived_at: null,
            created_at: '2026-08-12T12:00:11.000Z',
            task_title: title,
            candidate_title: null,
          }],
        }),
      });
      return;
    }
    if (url.pathname === '/api/notifications/issue11-notice/read' && method === 'POST') {
      notificationRead = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'issue11-notice', read_at: '2026-08-12T12:01:00.000Z' }) });
      return;
    }
    if (url.pathname === `/api/task-update-proposals/issue11-auto-proposal/revert` && method === 'POST') {
      autoReverted = true;
      status = 'unplanned';
      nextStep = '等待进一步说明。';
      taskVersion += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskDetail()) });
      return;
    }
    if (url.pathname === `/api/tasks/${taskId}/automation` && method === 'PATCH') {
      automationPaused = body?.paused === true;
      taskVersion += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskDetail()) });
      return;
    }
    if (url.pathname === `/api/tasks/${taskId}/references/${referenceId}` && method === 'DELETE') {
      referencePresent = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskDetail()) });
      return;
    }
    if (url.pathname === `/api/tasks/${taskId}/memory/rebuild` && method === 'POST') {
      memoryRebuilds += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskDetail().memory_projection) });
      return;
    }
    if (url.pathname === `/api/tasks/${taskId}` && method === 'PATCH') {
      title = typeof body?.title === 'string' ? body.title : title;
      describe = typeof body?.describe === 'string' ? body.describe : describe;
      nextStep = typeof body?.nextStep === 'string' ? body.nextStep : nextStep;
      risk = typeof body?.risk === 'string' ? body.risk : risk;
      waitingReason = body?.waitingReason === null || typeof body?.waitingReason === 'string' ? body.waitingReason : waitingReason;
      status = typeof body?.status === 'string' ? body.status : status;
      plannedStartAt = body?.plannedStartAt === null || typeof body?.plannedStartAt === 'string' ? body.plannedStartAt : plannedStartAt;
      plannedDueAt = body?.plannedDueAt === null || typeof body?.plannedDueAt === 'string' ? body.plannedDueAt : plannedDueAt;
      taskVersion += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskDetail()) });
      return;
    }
    if (url.pathname === `/api/tasks/${taskId}` && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskDetail()) });
      return;
    }
    if (url.pathname === '/api/tasks' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [taskDetail()] }) });
      return;
    }
    await route.continue();
  });

  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/#/');
  const attention = page.getByLabel('需要关注的提醒');
  await expect(attention).toContainText('AI 已自动维护私人任务');
  await attention.getByRole('button', { name: '查看并已读' }).click();
  expect(notificationRead).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/#/tasks\\?task=${taskId}&tab=updates$`));
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const automaticUpdate = page.locator('article[data-proposal-id="issue11-auto-proposal"]');
  await expect(automaticUpdate).toContainText('AI 已自动应用');
  await expect(automaticUpdate.locator('.proposal-change').first().locator('del')).toHaveText('待排期');
  await expect(automaticUpdate.locator('.proposal-change').first().locator('strong')).toHaveText('进行中');
  await expect(automaticUpdate).not.toContainText('deepseek / deepseek-v4-flash');
  await expect(automaticUpdate).toContainText('归属 99% · 字段 98%');
  terminalWarning = true;
  await page.reload();
  await page.getByRole('button', { name: /持续更新/ }).click();
  await expect(automaticUpdate).toHaveClass(/proposal-terminal-warning/);
  await expect(automaticUpdate.getByRole('alert')).toContainText('重点核对：AI 已把私人任务标为已完成');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  terminalWarning = false;
  await automaticUpdate.getByRole('button', { name: '撤销这次自动修改' }).click();
  await expect(page.getByText('AI 自动维护已撤销；历史审计仍保留。')).toBeVisible();
  await expect(automaticUpdate).toContainText('已撤销');

  await page.getByRole('button', { name: /编辑任务/ }).click();
  const editor = page.getByLabel('任务编辑');
  await expect(page.locator('.detail-grid select')).toBeDisabled();
  await expect(page.locator('.private-plan-editor input').first()).toBeDisabled();
  await expect(page.locator('.private-plan-editor input').last()).toBeDisabled();
  await expect(page.locator('.private-plan-editor').getByRole('button', { name: '保存我的计划' })).toBeDisabled();
  await expect(page.locator('.private-plan-editor').getByRole('button', { name: '清除安排' })).toBeDisabled();
  await editor.getByLabel('任务标题').fill('Issue #11 人工修正后的任务');
  await editor.getByLabel('Describe').fill('主人在 AI 自动维护后补充并修正了完整背景。');
  await editor.getByLabel('下一步').fill('按修正后的口径重新核验。');
  await editor.getByLabel('风险').selectOption('high');
  await editor.getByLabel('等待原因（可留空）').fill('等待需求方确认口径。');
  await editor.getByLabel('计划开始').fill('2030-08-15T09:00');
  await editor.getByLabel('计划完成').fill('2030-08-15T18:00');
  await editor.getByRole('button', { name: '保存全部修改' }).click();
  await expect(page.getByText('任务已完整更新并刷新任务记忆；这只是本机任务库中的修改。')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Issue #11 人工修正后的任务' })).toBeVisible();

  await page.getByRole('button', { name: '暂停自动维护' }).click();
  await expect(page.getByText('这项任务已暂停 AI 自动维护；后续消息仍会保存并进入待确认。')).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复自动维护' })).toBeVisible();
  await page.getByRole('button', { name: '恢复自动维护' }).click();
  await expect(page.getByText('这项任务已恢复 AI 自动维护。')).toBeVisible();

  await page.getByRole('button', { name: '参考路径' }).click();
  await expect(page.getByRole('button', { name: '解除 分析工作目录 的绑定' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole('button', { name: '解除 分析工作目录 的绑定' }).click();
  await expect(page.getByText('参考路径绑定已解除；真实工作目录没有变化。')).toBeVisible();
  await expect(page.getByText('这项任务还没有挂接参考路径。')).toBeVisible();

  await page.getByRole('button', { name: /持续更新/ }).click();
  await page.getByRole('button', { name: '清理并重建任务记忆' }).click();
  await expect(page.getByText('系统托管的旧投影已清理，任务记忆已重建；未知文件保持不变。')).toBeVisible();
  expect(memoryRebuilds).toBe(1);

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const overlappingButtons = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.task-drawer button')]
      .filter((button) => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      });
    return buttons.some((button, index) => buttons.slice(index + 1).some((other) => {
      const left = button.getBoundingClientRect();
      const right = other.getBoundingClientRect();
      return Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
        && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;
    }));
  });
  expect(overlappingButtons).toBe(false);

  await page.goto('/#/settings');
  const automationCard = page.getByLabel('AI 自动维护模式');
  await expect(automationCard).toBeVisible();
  const suggestMode = automationCard.getByRole('radio', { name: /仅建议/ });
  await suggestMode.click();
  await expect(suggestMode).toBeChecked();
  await expect(page.getByText('已切换为仅建议；来源继续保存，但 AI 不再自动改正式任务。')).toBeVisible();
  expect(automationMode).toBe('suggest');
  const automaticMode = automationCard.getByRole('radio', { name: /自动维护/ });
  await automaticMode.click();
  await expect(automaticMode).toBeChecked();
  await expect(page.getByText('已启用 AI 自动维护本机任务；低置信度、推测时间和版本冲突仍会等待你确认。')).toBeVisible();
  expect(automationMode).toBe('auto');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  if (process.env.CAPTURE_ISSUE11_QA) {
    await page.screenshot({ path: testInfo.outputPath(`issue11-auto-maintenance-${testInfo.project.name}.png`), fullPage: true });
  }
});

test('集成设置明确连接边界，且不暴露开发消息夹具', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '集成设置' })).toBeVisible();
  await expect(page.getByText('当前使用本地规则或 Mock，不会访问飞书或外部模型。')).toBeVisible();
  await expect(page.getByText('开发者工具', { exact: true })).toBeVisible();
  await expect(page.getByText('退出后台进程', { exact: true })).toBeVisible();
  await expect(page.getByText('退出本机任务库后台后，当前浏览器页面会失去连接；任务数据仍保留在本机 SQLite 中。', { exact: true })).toBeVisible();
  await expect(page.locator('article.source-status-row').first()).toContainText('暂无记录');
  await expect(page.getByRole('button', { name: '重新同步' })).toHaveCount(5);
  await page.getByText('我的日历', { exact: true }).locator('xpath=ancestor::article').getByRole('button', { name: '重新同步' }).click();
  await expect(page.getByText('我的日历：skipped（已跳过），本轮未执行同步。')).toBeVisible();
  await expect(page.getByRole('button', { name: '模拟一条需求（浏览器测试）' })).toBeVisible();
  await expect(page.getByRole('button', { name: '模拟收到消息' })).toHaveCount(0);
  await expect(page.getByText('虚拟消息测试')).toHaveCount(0);
});

test('设置页可以重启本机任务库后台并继续使用当前页面', async ({ page }) => {
  let restartCalls = 0;
  await page.route('**/api/runtime/restart', async (route) => {
    restartCalls += 1;
    expect(route.request().method()).toBe('POST');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: '后台已重启，本页可继续用。' }) });
  });

  await page.goto('/settings');
  await page.getByRole('button', { name: '重启本机任务库后台' }).click();
  await expect(page.getByText('后台已重启，本页可继续用。', { exact: true })).toBeVisible();
  await expect(page.getByText('后台已退出，请关闭此标签页', { exact: true })).toHaveCount(0);
  expect(restartCalls).toBe(1);
});

test('设置页可以即时保存每 10 分钟自动扫描开关', async ({ page }) => {
  let enabled = false;
  const savedValues: boolean[] = [];
  await page.route('**/api/runtime/auto-scan', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled }) });
      return;
    }
    expect(route.request().method()).toBe('PUT');
    const body = route.request().postDataJSON() as { enabled?: boolean };
    expect(typeof body.enabled).toBe('boolean');
    enabled = body.enabled as boolean;
    savedValues.push(enabled);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled }) });
  });

  await page.goto('/settings');
  const toggle = page.getByRole('checkbox', { name: '每 10 分钟自动扫描新任务' });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('打开后还需在 Cindy 插件设置里保存过自动化；关闭后定时即使触发也不入库。手动扫描不受影响。', { exact: true })).toBeVisible();
  await expect(page.getByText('入库扫描模型请到 Cindy 插件详情「AI 代办」里改：推荐折扣路由 codex/gpt-5.6-luna、思考强度 high、权限 自动审核。草稿默认可能是 fable5，改完要保存。', { exact: true })).toBeVisible();

  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(page.getByText('已开启每 10 分钟自动扫描新任务。', { exact: true })).toBeVisible();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('已关闭每 10 分钟自动扫描；定时触发不会入库。', { exact: true })).toBeVisible();
  expect(savedValues).toEqual([true, false]);
});

test('来源同步碰到后台轮次时显示真实忙碌状态，不误报配置问题', async ({ page }) => {
  await page.route('**/api/integrations/feishu/sources/calendar/sync', async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, any>;
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify({
        ...payload,
        outcome: 'skipped',
        messages: 0,
        failures: 0,
        skipped: true,
        sources: [{ source: 'calendar', status: 'skipped', counts: {}, duration_ms: 1, error_code: 'OBS_ALREADY_RUNNING', reason: 'OBS_ALREADY_RUNNING', next_retry_at: '2026-08-15T02:00:00.000Z', stale: true, message: '该来源本轮未执行。' }],
      }),
    });
  });
  await page.goto('/settings');
  await page.getByText('我的日历', { exact: true }).locator('xpath=ancestor::article').getByRole('button', { name: '重新同步' }).click();
  await expect(page.getByText('我的日历：skipped（已跳过），本轮未执行同步。')).toBeVisible();
  await expect(page.locator('.warning-banner')).toContainText('skipped（已跳过）');
});

test('单来源返回非法 fulfilled 结果时明确显示 failure，不误报完成或跳过', async ({ page }) => {
  await page.route('**/api/integrations/feishu/sources/calendar/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'failure',
        duration_ms: 1,
        messages: 0,
        failures: 1,
        skipped: false,
        sources: [{ source: 'calendar', status: 'failure', counts: { failures: 1 }, duration_ms: 1, error_code: 'OBS_INVALID_SOURCE_RESULT', reason: 'OBS_INVALID_SOURCE_RESULT', next_retry_at: '2026-08-15T02:00:00.000Z', stale: true, message: '该来源同步失败；已保留安全诊断信息。' }],
      }),
    });
  });
  await page.goto('/settings');
  await page.getByText('我的日历', { exact: true }).locator('xpath=ancestor::article').getByRole('button', { name: '重新同步' }).click();
  const errorBanner = page.locator('.error-banner');
  await expect(errorBanner).toContainText('我的日历：failure（失败）');
  await expect(errorBanner).toContainText('未完成同步');
  await expect(errorBanner).not.toContainText(/同步完成|当前配置跳过|已跳过/u);
});

test('集成设置默认不关注个人，一键关注所有人后仍可单独选择群聊', async ({ page }) => {
  const source = (kind: string, status: string, scopeSummary: string, requiresBotInChat = false) => ({
    kind,
    enabled: true,
    status,
    scopeSummary,
    requiresAdmin: kind !== 'bot_supplement',
    requiresBotInChat,
    syncMode: kind === 'bot_supplement' ? 'mixed' : 'periodic',
    lastSuccessAt: null,
    lastError: null,
    details: {},
    updatedAt: '2026-08-11T10:00:00.000Z',
  });
  await page.route('**/api/owner-information', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        owner: { openId: 'owner-open', unionId: null, userId: null, name: '系统主人', tenantKey: 'tenant', oauthStatus: 'authorized', configuredScopes: [], lastSyncedAt: null },
        sources: [
          source('owner_dm', 'partial', '已支持自动发现现有私聊，主人选择后读取。'),
          source('owner_mentions', 'partial', '已支持按群名选择主人所在群。'),
          source('calendar', 'partial', '日历范围待租户验收。'),
          source('minutes', 'partial', '妙记范围待租户验收。'),
          source('bot_supplement', 'partial', '机器人补充入口。', true),
        ],
      }),
    });
  });
  const selectedPeople = new Set<string>();
  const selectedGroups = new Set<string>();
  const patchBodies: Array<{ personChanges?: Array<{ id: string; selected: boolean }>; groupIds?: string[] }> = [];
  const monitoringScope = () => ({
    ownerAuthorized: true,
    people: [
      { id: 'monitor-person-a', kind: 'person', name: '张三', secondaryLabel: '数据中心 · zhangsan@example.com', selected: selectedPeople.has('monitor-person-a'), readPolicy: 'incoming_only', accessStatus: 'readable', lastDiscoveredAt: null, lastSuccessAt: null, lastError: null },
      { id: 'monitor-person-b', kind: 'person', name: '李四', secondaryLabel: '产品中心', selected: selectedPeople.has('monitor-person-b'), readPolicy: 'incoming_only', accessStatus: 'unknown', lastDiscoveredAt: null, lastSuccessAt: null, lastError: null },
    ],
    groups: [
      { id: 'monitor-group-a', kind: 'group', name: '数据需求群', secondaryLabel: null, selected: selectedGroups.has('monitor-group-a'), readPolicy: 'owner_mentions', accessStatus: 'readable', lastDiscoveredAt: null, lastSuccessAt: null, lastError: null },
      { id: 'monitor-group-b', kind: 'group', name: '项目同步群', secondaryLabel: null, selected: false, readPolicy: 'owner_mentions', accessStatus: 'readable', lastDiscoveredAt: null, lastSuccessAt: null, lastError: null },
    ],
    selectedPersonCount: selectedPeople.size,
    selectedGroupCount: selectedGroups.size,
    limits: { people: 5000, groups: 50 },
    updatedAt: '2026-08-11T10:00:00.000Z',
  });
  await page.route('**/api/integrations/feishu/monitoring-scope', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(monitoringScope()) });
      return;
    }
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { personChanges?: Array<{ id: string; selected: boolean }>; groupIds?: string[] };
      patchBodies.push(body);
      for (const change of body.personChanges ?? []) change.selected ? selectedPeople.add(change.id) : selectedPeople.delete(change.id);
      if (body.groupIds) {
        selectedGroups.clear();
        for (const id of body.groupIds) selectedGroups.add(id);
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(monitoringScope()) });
      return;
    }
    await route.continue();
  });

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '选择要关注的个人和群聊' })).toBeVisible();
  await expect(page.getByText('新发现的人员默认不关注。')).toBeVisible();
  await expect(page.getByText('不要求机器人在群内；机器人补充群在下方单独配置。')).toBeVisible();
  await expect(page.getByText('已关注 0 个个人单聊和 0 个群聊。')).toBeVisible();
  await page.getByRole('button', { name: '关注所有人' }).click();
  await expect(page.getByText('已关注当前发现的 2 位联系人；以后新发现的人仍默认不关注。')).toBeVisible();
  expect(patchBodies[0]).toEqual({ personChanges: [
    { id: 'monitor-person-a', selected: true },
    { id: 'monitor-person-b', selected: true },
  ] });
  await page.locator('label.monitoring-option').filter({ hasText: '数据需求群' }).click();
  await page.getByRole('button', { name: '保存范围设置' }).click();
  await expect(page.getByText('已保存：已关注 2 个个人单聊、1 个群聊。群聊仍只处理真实 @你。')).toBeVisible();
  expect(patchBodies[1]).toEqual({ personChanges: [], groupIds: ['monitor-group-a'] });
  await expect(page.getByText('owner-open')).toHaveCount(0);
  await expect(page.getByText('group-a')).toHaveCount(0);

  const dm = page.getByText('我的普通私聊', { exact: true }).locator('xpath=ancestor::article');
  await expect(dm).toContainText('只能读取部分范围');
  await expect(dm.getByRole('button', { name: '重新同步' })).toBeEnabled();
  await dm.getByText('详情', { exact: true }).click();
  await expect(dm).toContainText('自动发现飞书实际返回的既有一对一会话，但默认不关注');

  const mention = page.getByText('群聊中 @我', { exact: true }).locator('xpath=ancestor::article');
  await expect(mention).toContainText('只能读取部分范围');
  await mention.getByText('详情', { exact: true }).click();
  await expect(mention).toContainText('不要求机器人在群内');
  await expect(mention).toContainText('仅把真实 @你的消息持久化');
});

test('集成设置加载时不闪现假故障，可选机器人不计入主来源异常', async ({ page }) => {
  let releaseOwnerInformation: () => void = () => undefined;
  const ownerInformationGate = new Promise<void>((resolve) => { releaseOwnerInformation = resolve; });
  await page.route('**/api/owner-information', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await ownerInformationGate;
    const source = (kind: string, enabled = true) => ({
      kind,
      enabled,
      status: enabled ? 'ready' : 'partial',
      scopeSummary: enabled ? '当前来源可用。' : '可选补充入口未启用。',
      requiresAdmin: false,
      requiresBotInChat: kind === 'bot_supplement',
      syncMode: enabled ? '周期增量同步' : '按需启用',
      lastSuccessAt: enabled ? '2026-08-11T06:00:00.000Z' : null,
      lastError: null,
      updatedAt: '2026-08-11T06:00:00.000Z',
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        owner: {
          openId: 'ou_e2e_owner',
          unionId: null,
          userId: null,
          name: 'E2E 主人',
          tenantKey: 'tenant-e2e',
          oauthStatus: 'authorized',
          configuredScopes: [],
          lastSyncedAt: '2026-08-11T06:00:00.000Z',
        },
        sources: [source('owner_dm'), source('owner_mentions'), source('calendar'), source('minutes'), source('bot_supplement', false)],
      }),
    });
  });
  await page.goto('/settings');
  await expect(page.getByText('正在读取状态')).toBeVisible();
  releaseOwnerInformation();
  await expect(page.getByText('4 项可用或受限')).toBeVisible();
  await expect(page.getByText('机器人补充入口未启用（可选）', { exact: true })).toBeVisible();
  await expect(page.getByText(/项待处理/)).toHaveCount(0);

  const rows = page.locator('article.source-status-row');
  const lastRow = rows.last();
  await lastRow.locator('summary').click();
  await expect(lastRow.locator('.source-status-details > div')).toBeVisible();
  const contained = await lastRow.evaluate((row) => {
    const detail = row.querySelector('.source-status-details > div') as HTMLElement | null;
    if (!detail) return false;
    const rowBox = row.getBoundingClientRect();
    const detailBox = detail.getBoundingClientRect();
    return detailBox.top >= rowBox.top && detailBox.bottom <= rowBox.bottom + 1;
  });
  expect(contained).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('同步全部显示真实忙碌状态并阻止重复提交', async ({ page }) => {
  let calls = 0;
  let releaseSync: () => void = () => undefined;
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  await page.route('**/api/integrations/feishu/sync', async (route) => {
    calls += 1;
    await syncGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outcome: 'success', messages: 0, failures: 0, skipped: false, sources: [{ source: 'calendar', status: 'success', counts: {}, duration_ms: 1, error_code: null, reason: null, next_retry_at: null, stale: false, message: '该来源同步成功。' }] }) });
  });
  await page.goto('/settings');
  const syncAll = page.getByRole('button', { name: '同步全部' });
  await syncAll.click();
  await expect(page.getByRole('button', { name: '同步中…' })).toBeDisabled();
  await expect(page.getByText('正在同步全部个人信息来源…')).toBeVisible();
  await expect(syncAll).toHaveCount(0);
  releaseSync();
  await expect(page.getByRole('button', { name: '同步全部' })).toBeEnabled();
  expect(calls).toBe(1);
});

test('同步全部一来源失败时明确显示 partial_success，不误报全部完成', async ({ page }) => {
  await page.route('**/api/integrations/feishu/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'partial_success',
        duration_ms: 3,
        messages: 4,
        failures: 1,
        skipped: false,
        sources: [
          { source: 'owner_messages', status: 'success', counts: { messages: 4 }, duration_ms: 2, error_code: null, reason: null, next_retry_at: null, stale: false, message: '该来源同步成功。' },
          { source: 'calendar', status: 'failure', counts: { failures: 1 }, duration_ms: 1, error_code: 'OBS_INTERNAL_FAILURE', reason: 'OBS_INTERNAL_FAILURE', next_retry_at: '2026-08-15T02:00:00.000Z', stale: true, message: '该来源同步失败；已保留安全诊断信息。' },
        ],
      }),
    });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: '同步全部' }).click();
  await expect(page.locator('.warning-banner')).toContainText('partial_success（部分成功）');
  await expect(page.getByText(/统一同步完成/)).toHaveCount(0);
});

test('Issue #58 同步来源明细与 readiness 分开呈现且未知文本不泄漏', async ({ page }) => {
  let healthCalls = 0;
  await page.route('**/api/health', async (route) => {
    healthCalls += 1;
    const body = healthCalls === 1
      ? {
          operation_id: '11111111-1111-4111-8111-111111111111', request_id: '22222222-2222-4222-8222-222222222222', liveness: { status: 'alive' }, dependencies: e2eHealthDependencies(),
          readiness: { status: 'degraded', reasons: [{ code: 'SOURCE_PARTIAL', message: 'SECRET_CANARY_MESSAGE_58' }] },
          release: { app_version: '0.2.0', build_identity: '0123456789abcdef0123456789abcdef01234567', redaction_schema_version: '1' }, timestamp: '2026-08-15T01:00:00.000Z',
        }
      : {
          operation_id: 'SECRET_CANARY_OPERATION_58', request_id: 'SECRET_CANARY_REQUEST_58', liveness: { status: 'alive' },
          readiness: { status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE', message: 'raw-db-canary-58' }, { code: 'SECRET_CANARY_REASON_58', message: 'SECRET_CANARY_MESSAGE_58' }] }, dependencies: e2eHealthDependencies(),
          release: { app_version: 'SECRET_CANARY_VERSION_58', build_identity: 'SECRET_CANARY_BUILD_58', redaction_schema_version: 'SECRET_CANARY_SCHEMA_58' }, timestamp: '2026-08-15T01:01:00.000Z',
        };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/api/integrations/feishu/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        operation_id: 'SECRET_CANARY_OPERATION_SYNC_58', request_id: 'SECRET_CANARY_REQUEST_SYNC_58', outcome: 'partial_success', duration_ms: 18,
        release: { app_version: 'SECRET_CANARY_VERSION_SYNC_58', build_identity: 'SECRET_CANARY_BUILD_SYNC_58', redaction_schema_version: 'SECRET_CANARY_SCHEMA_SYNC_58' },
        sources: [
          { source: 'owner_messages', status: 'success', counts: { messages: 4 }, duration_ms: 5, error_code: null, reason: null, next_retry_at: null, stale: false, message: 'SECRET_CANARY_SOURCE_MESSAGE_58' },
          { source: 'calendar', status: 'failure', counts: { failures: 1 }, duration_ms: 7, error_code: 'FEISHU_SYNC_PARTIAL', reason: 'FEISHU_SYNC_PARTIAL', message: 'SECRET_CANARY_SOURCE_FAILURE_58', stale: true, next_retry_at: '2026-08-15T02:00:00.000Z' },
        ],
      }),
    });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: '同步全部' }).click();
  await expect(page.getByRole('heading', { name: '同步结果：部分同步' })).toBeVisible();
  const syncPanel = page.getByLabel('同步结果');
  await expect(syncPanel).toContainText('主人消息');
  await expect(syncPanel).toContainText('日历');
  await expect(syncPanel).toContainText('FEISHU_SYNC_PARTIAL');
  await expect(syncPanel).toContainText('数据陈旧');
  await expect(syncPanel).not.toContainText(/raw-source|raw-health|raw-db/u);
  const healthPanel = page.getByRole('region', { name: '系统健康' });
  await expect(healthPanel.locator('.health-readiness')).toHaveText('部分受限');
  await expect(healthPanel.getByText('至少一个已启用信息源只能部分工作。', { exact: true })).toBeVisible();
  await healthPanel.getByRole('button', { name: '重试' }).click();
  await expect(healthPanel.locator('.health-readiness')).toHaveText('暂不可用');
  await expect(healthPanel.getByText('健康状态暂时无法确认。', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/SECRET_CANARY|raw-db-canary-58/u);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('同步全部全部失败时明确显示 failure 错误状态', async ({ page }) => {
  await page.route('**/api/integrations/feishu/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'failure',
        duration_ms: 2,
        messages: 0,
        failures: 5,
        skipped: false,
        sources: [{ source: 'feishu', status: 'failure', counts: { failures: 5 }, duration_ms: 1, error_code: 'OBS_INTERNAL_FAILURE', reason: 'OBS_INTERNAL_FAILURE', next_retry_at: '2026-08-15T02:00:00.000Z', stale: true, message: '该来源同步失败；已保留安全诊断信息。' }],
      }),
    });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: '同步全部' }).click();
  await expect(page.locator('.error-banner')).toContainText('failure（失败）');
  await expect(page.locator('.error-banner')).toContainText('未完成同步');
  await expect(page.getByText(/当前配置跳过|统一同步完成/)).toHaveCount(0);
});

test('桌面授权会先保存当前 scope，再打开飞书授权页', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const initial = {
      setupComplete: true,
      launchAtLogin: false,
      logRetentionDays: 30,
      feishu: {
        appId: 'cli_test',
        externalEnabled: true,
        domain: 'feishu',
        eventMode: 'websocket',
        oauthRedirectUri: 'http://127.0.0.1:4311/oauth/feishu/callback',
        oauthScopes: '',
        scanEnabled: false,
        scanIntervalSeconds: 60,
        groupIds: [],
      },
      llm: { provider: 'rule_mock', model: '', apiBase: '', timeoutMs: 30000, maxRetries: 2 },
      workspace: { readEnabled: false, allowedPaths: [] },
      secretState: {
        feishuAppSecret: true,
        feishuUserAccessToken: false,
        feishuRefreshToken: false,
        llmApiKey: false,
        feishuUserToken: false,
      },
    };
    (window as any).__savedDesktopConfig = null;
    (window as any).__feishuAuthorizeCalls = 0;
    (window as any).__copiedPermissionText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { (window as any).__copiedPermissionText = value; } },
    });
    (window as any).aiPmDesktop = {
      api: {
        request: async ({ method, url, body }: { method: string; url: string; body?: unknown }) => {
          const response = await fetch(url, {
            method,
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        },
      },
      app: { info: async () => ({ version: 'test', platform: 'win32', packaged: true }), relaunch: async () => undefined },
      config: {
        get: async () => initial,
        save: async (input: any) => {
          const { secrets: _secrets, ...saved } = input;
          (window as any).__savedDesktopConfig = saved;
          return saved;
        },
      },
      feishu: { authorize: async () => { (window as any).__feishuAuthorizeCalls += 1; return { opened: true }; } },
      workspace: { pickDirectory: async () => null },
      diagnostics: { export: async () => ({ saved: false }) },
    };
  });
  await page.goto('/#/settings');
  await expect(page.getByRole('button', { name: '只校验输入格式' })).toHaveCount(0);
  await expect(page.getByText('浏览器开发模式：仅校验格式')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '飞书连接' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '判断模型' })).toBeVisible();
  await expect(page.getByText('本机与工作目录', { exact: true })).toBeVisible();
  await expect(page.getByLabel('OAuth 回调地址')).toBeVisible();
  await expect(page.getByLabel('OAuth 权限范围（空格分隔）')).toBeVisible();
  await expect(page.locator('details.feishu-permission-guide')).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CAPTURE_SETTINGS_QA) {
    await page.screenshot({ path: testInfo.outputPath(`settings-${testInfo.project.name}-collapsed-native.png`), fullPage: true });
  }
  await page.getByText('飞书权限开通指南', { exact: true }).click();
  await expect(page.getByRole('img', { name: '飞书开放平台权限管理与批量导入权限示意图' })).toBeVisible();
  const permissionJson = page.getByLabel('飞书批量导入权限 JSON');
  await expect(permissionJson).toContainText('"tenant"');
  await expect(permissionJson).toContainText('"user"');
  await expect(permissionJson).toContainText('docx:document:readonly');
  await page.getByRole('button', { name: '复制 JSON' }).click();
  await expect(page.getByText('已复制；请粘贴到飞书开放平台的批量导入窗口。')).toBeVisible();
  await page.getByRole('button', { name: '填入程序的 OAuth scope' }).click();
  await expect(page.locator('details.feishu-permission-guide')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: '保存并开始授权' }).click();
  await expect(page.getByText('当前配置已保存，并已打开飞书授权页面；请只使用最新打开的这一页。')).toBeVisible();
  const saved = await page.evaluate(() => ({
    scope: (window as any).__savedDesktopConfig?.feishu?.oauthScopes,
    authorizeCalls: (window as any).__feishuAuthorizeCalls,
  }));
  expect(saved.scope).toContain('im:message.group_msg:get_as_user');
  expect(saved.scope).not.toContain('search:message');
  expect(saved.scope).toContain('calendar:calendar:readonly');
  expect(saved.scope).toContain('minutes:minutes.transcript:export');
  expect(saved.scope).toContain('docx:document:readonly');
  expect(saved.scope).toContain('wiki:node:read');
  expect(saved.authorizeCalls).toBe(1);
  expect(await page.evaluate(() => (window as any).__copiedPermissionText)).toContain('"tenant"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CAPTURE_SETTINGS_QA) {
    await page.screenshot({ path: testInfo.outputPath(`settings-${testInfo.project.name}-expanded-native.png`), fullPage: true });
  }
  await page.setViewportSize(testInfo.project.name.includes('mobile') ? { width: 320, height: 568 } : { width: 1100, height: 720 });
  await expect(page.getByRole('heading', { name: '飞书连接' })).toBeVisible();
  await expect(page.getByLabel('OAuth 回调地址')).toBeVisible();
  await expect(page.getByLabel('OAuth 权限范围（空格分隔）')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CAPTURE_SETTINGS_QA) {
    await page.screenshot({ path: testInfo.outputPath(`settings-${testInfo.project.name}-expanded-narrow.png`), fullPage: true });
  }
  await page.getByText('飞书权限开通指南', { exact: true }).click();
  await expect(page.locator('details.feishu-permission-guide')).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (process.env.CAPTURE_SETTINGS_QA) {
    await page.screenshot({ path: testInfo.outputPath(`settings-${testInfo.project.name}-collapsed-narrow.png`), fullPage: true });
  }
});

test('日志中心支持日期筛选、保留期清理和一键删除入口', async ({ page }) => {
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: '日志与纠错' })).toBeVisible();
  await expect(page.getByLabel('开始日期')).toBeVisible();
  await expect(page.getByLabel('结束日期')).toBeVisible();
  await expect(page.getByRole('button', { name: '清理到期日志' })).toBeVisible();
  await expect(page.getByRole('button', { name: '一键删除日志' })).toBeVisible();
});

test('Issue #58 日志中心展示受控运行事件且不泄漏原始字段', async ({ page }) => {
  await page.route('**/api/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        liveness: { status: 'alive' },
        readiness: { status: 'not_ready', reasons: [{ code: 'SECRET_CANARY_REASON_58', message: 'SECRET_CANARY_HEALTH_MESSAGE_58' }] },
      }),
    });
  });
  await page.route('**/api/logs*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        logs: [
          { id: 'log-1', category: 'runtime', level: 'error', event_type: 'feishu.sync.completed', summary: 'SECRET_CANARY_LOG_SUMMARY', context_json: 'SECRET_CANARY_CONTEXT', created_at: '2026-08-16T00:00:00.000Z' },
          { id: 'log-2', category: 'runtime', level: 'info', event_type: 'SECRET_CANARY_EVENT', summary: 'SECRET_CANARY_UNKNOWN', created_at: 'SECRET_CANARY_TIME' },
        ],
        decisions: [{ id: 'refresh_token app_secret client_secret Bearer plain-error invalid-id', provider: 'refresh_token', model: 'app_secret', prompt_version: 'client_secret', used_fallback: 'false', fallback_mode: 'plain-error', input_char_count: 'invalid-id', unknown_field: 'SECRET_CANARY_UNKNOWN_FIELD' }],
        health: [{ integration: 'refresh_token', status: 'app_secret', message: 'client_secret Bearer plain-error', latency_ms: 'invalid-id', checked_at: 'SECRET_CANARY_HEALTH_TIME' }],
        corrections: [{ id: 'refresh_token', correction_type: 'invalid-id', note: 'plain-error Bearer', candidate_id: 'client_secret', task_id: 'app_secret', created_at: 'SECRET_CANARY_CORRECTION_TIME' }],
      }),
    });
  });
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: '运行事件' })).toBeVisible();
  await expect(page.locator('section.log-section strong').filter({ hasText: '信息源同步已结束' })).toBeVisible();
  await expect(page.getByText('未提供连接', { exact: true })).toBeVisible();
  await expect(page.getByText('连接状态暂未提供安全说明。', { exact: true })).toBeVisible();
  await expect(page.getByText('已记录 / 已记录', { exact: true })).toBeVisible();
  await expect(page.getByText('未提供安全说明', { exact: true })).toBeVisible();
  await expect(page.getByText('当前原因', { exact: true })).toBeVisible();
  await expect(page.getByText('健康状态暂时无法确认。', { exact: true })).toBeVisible();
  await expect(page.getByText('当前没有后端报告的降级原因', { exact: false })).toHaveCount(0);
  await expect(page.getByText(/refresh_token|app_secret|client_secret|Bearer|plain-error|SECRET_CANARY/u)).toHaveCount(0);
});

test('Issue #51 任务读取失败不会显示为空', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: test.info().testId,
      consoleText: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      method: 'GET',
      pathname: '/api/tasks',
      search: '',
      status: 503,
      expectedCount: 1,
    }),
  });
  await page.route('**/api/tasks*', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '任务台账暂不可用。' }) });
  });
  await page.goto('/tasks');
  await expect(page.getByRole('alert')).toContainText('任务列表读取失败');
  await expect(page.getByText('目前还没有正式任务。')).toHaveCount(0);
});

test('Issue #51 排期读取失败不会显示为空', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: test.info().testId,
      consoleText: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      method: 'GET',
      pathname: '/api/calendar',
      search: '',
      status: 503,
      expectedCount: 1,
    }),
  });
  await page.route('**/api/calendar', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '排期暂不可用。' }) });
  });
  await page.goto('/calendar');
  await expect(page.getByRole('alert')).toContainText('排期日历读取失败');
  await expect(page.getByText('还没有已经排期的任务。')).toHaveCount(0);
});

test('Issue #51 归档读取失败不会显示为空', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: test.info().testId,
      consoleText: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      method: 'GET',
      pathname: '/api/tasks',
      search: '?recordState=all&deleted=all',
      status: 503,
      expectedCount: 1,
    }),
  });
  await page.route('**/api/tasks*', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '归档暂不可用。' }) });
  });
  await page.goto('/archive');
  await expect(page.getByRole('alert')).toContainText('归档和回收站读取失败');
  await expect(page.getByText('回收站是空的。')).toHaveCount(0);
});

test('Issue #51 候选读取失败不会伪装成空收件箱', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: test.info().testId,
      consoleText: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      method: 'GET',
      pathname: '/api/candidates',
      search: '?deleted=all',
      status: 503,
      expectedCount: 1,
    }),
  });
  await page.route('**/api/candidates*', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '候选收件箱暂不可用。' }) });
  });
  await page.goto('/candidates');
  await expect(page.getByRole('alert')).toContainText('候选收件箱读取失败');
  await expect(page.getByText('这个分类里还没有候选需求。')).toHaveCount(0);
});

test('Issue #51 设置分区独立失败，配置失败不阻塞其他状态', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: test.info().testId,
      consoleText: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      method: 'GET',
      pathname: '/api/configuration',
      search: '',
      status: 503,
      expectedCount: 1,
    }),
  });
  await page.route('**/api/configuration', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '配置状态暂不可用。' }) });
  });
  await page.route('**/api/owner-information', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ owner: null, sources: [] }) });
  });
  await page.route('**/api/automation-policy', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: 'suggest', associationThreshold: 0.9, updateThreshold: 0.9, policyVersion: 'e2e', updatedAt: '2026-08-15T00:00:00.000Z' }) });
  });
  await page.route('**/api/integrations/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ readiness: { status: 'degraded', reasons: [{ code: 'SOURCE_ERROR', message: '测试状态' }] }, dependencies: e2eHealthDependencies() }) });
  });
  await page.route('**/api/integrations/feishu/monitoring-scope', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ownerAuthorized: false, people: [], groups: [], selectedPersonCount: 0, selectedGroupCount: 0, limits: { people: 50, groups: 50 }, updatedAt: null }) });
  });
  await page.goto('/settings');
  await expect(page.getByRole('alert')).toContainText('配置状态读取失败');
  await expect(page.getByRole('heading', { name: '我的个人信息流' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 如何维护我的任务' })).toBeVisible();
  await expect(page.getByText('还没有连接检查记录')).toBeVisible();
});

test('Issue #51 刷新失败保留上次成功数据并标记陈旧', async ({ page }) => {
  test.info().annotations.push({
    type: 'allow-console-error-for-response',
    description: JSON.stringify({
      testScope: test.info().testId,
      consoleText: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      method: 'GET',
      pathname: '/api/tasks',
      search: '',
      status: 503,
      expectedCount: 1,
    }),
  });
  const task = { ...issue52TaskDetail('issue51-stale-task', 'Issue #51 陈旧任务') };
  let attempts = 0;
  await page.route('**/api/tasks', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [task] }) });
      return;
    }
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '刷新暂时失败。' }) });
  });
  await page.goto('/tasks');
  await expect(page.getByText(task.title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByText('数据可能已过期')).toBeVisible();
  await expect(page.getByText(task.title, { exact: true })).toBeVisible();
  await expect(page.getByText('目前还没有正式任务。')).toHaveCount(0);
});

test('Issue #51 主人刷新成功后，迟到的旧主人读取不会覆盖新主人', async ({ page }) => {
  let releaseOldOwner!: () => void;
  const oldOwner = new Promise<void>((resolve) => { releaseOldOwner = resolve; });
  let ownerGets = 0;
  const owner = (name: string, openId: string) => ({
    owner: { openId, unionId: null, userId: null, name, tenantKey: 'tenant-e2e', oauthStatus: 'authorized', configuredScopes: [], lastSyncedAt: '2026-08-15T01:00:00.000Z' },
    sources: [],
  });
  await page.route('**/api/configuration', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ liveConnectionsEnabled: false, notice: '仅使用本地 Mock。', integrations: [] }) });
  });
  await page.route('**/api/owner-information', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    ownerGets += 1;
    if (ownerGets === 1) await oldOwner;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(owner('旧主人', 'old-owner')) });
  });
  await page.route('**/api/integrations/feishu/owner/refresh', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(owner('新主人', 'new-owner')) });
  });
  await page.route('**/api/automation-policy', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: 'suggest', associationThreshold: 0.9, updateThreshold: 0.9, policyVersion: 'e2e', updatedAt: '2026-08-15T00:00:00.000Z' }) });
  });
  await page.route('**/api/integrations/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ readiness: { status: 'ready', reasons: [] }, dependencies: e2eHealthDependencies() }) });
  });
  await page.route('**/api/integrations/feishu/monitoring-scope', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ownerAuthorized: false, people: [], groups: [], selectedPersonCount: 0, selectedGroupCount: 0, limits: { people: 50, groups: 50 }, updatedAt: null }) });
  });

  await page.goto('/settings');
  await page.getByRole('button', { name: '重新读取身份' }).click();
  await expect(page.getByText('新主人', { exact: true })).toBeVisible();
  releaseOldOwner();
  await expect(page.getByText('新主人', { exact: true })).toBeVisible();
  await expect(page.getByText('旧主人', { exact: true })).toHaveCount(0);
  expect(ownerGets).toBe(1);
});

test('Issue #51 任务刷新只接受最新请求，迟到响应不会覆盖新结果', async ({ page }) => {
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let attempts = 0;
  const oldTask = issue52TaskDetail('issue51-old-task', '旧请求任务');
  const latestTask = issue52TaskDetail('issue51-latest-task', '最新请求任务');
  await page.route('**/api/tasks', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await firstRelease;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [oldTask] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [latestTask] }) });
  });
  await page.goto('/tasks');
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByText(latestTask.title, { exact: true })).toBeVisible();
  releaseFirst();
  await expect(page.getByText(latestTask.title, { exact: true })).toBeVisible();
  await expect(page.getByText(oldTask.title, { exact: true })).toHaveCount(0);
});

test('Issue #51 候选刷新只接受最新请求，迟到响应不会覆盖新结果', async ({ page }) => {
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let attempts = 0;
  const oldCandidate = { ...issue57Candidate, id: 'issue51-old-candidate', title: '旧请求候选' };
  const latestCandidate = { ...issue57Candidate, id: 'issue51-latest-candidate', title: '最新请求候选' };
  await page.route('**/api/candidates?deleted=all', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await firstRelease;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [oldCandidate], ownerActions: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [latestCandidate], ownerActions: [] }) });
  });
  await page.goto('/candidates');
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByText(latestCandidate.title, { exact: true })).toBeVisible();
  releaseFirst();
  await expect(page.getByText(latestCandidate.title, { exact: true })).toBeVisible();
  await expect(page.getByText(oldCandidate.title, { exact: true })).toHaveCount(0);
});
