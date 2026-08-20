import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/database.js';
import {
  MAX_SHANGHAI_CALENDAR_SPAN_DAYS,
  assertShanghaiCalendarPlanRange,
  projectShanghaiCalendarPlan,
  shanghaiCalendarDateKeys,
  shanghaiDayWindow,
} from '../src/shanghai-time.js';

describe('上海自然日边界', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['上海 00:00', '2026-08-14T16:00:00.000Z', '2026-08-15', '2026-08-14T16:00:00.000Z', '2026-08-15T16:00:00.000Z'],
    ['上海 23:59', '2026-08-15T15:59:59.999Z', '2026-08-15', '2026-08-14T16:00:00.000Z', '2026-08-15T16:00:00.000Z'],
    ['UTC 跨日仍属上海当天', '2026-08-15T00:30:00.000Z', '2026-08-15', '2026-08-14T16:00:00.000Z', '2026-08-15T16:00:00.000Z'],
    ['跨月', '2026-01-31T16:00:00.000Z', '2026-02-01', '2026-01-31T16:00:00.000Z', '2026-02-01T16:00:00.000Z'],
    ['跨年', '2025-12-31T16:00:00.000Z', '2026-01-01', '2025-12-31T16:00:00.000Z', '2026-01-01T16:00:00.000Z'],
  ])('%s', (_label, instant, date, startAt, endAt) => {
    expect(shanghaiDayWindow(instant)).toEqual({ date, startAt, endAt });
  });

  it('演示任务排期不跟随服务器本地时区漂移', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ now: new Date('2026-08-15T00:30:00.000Z') });
    const database = new AppDatabase(':memory:', true);
    try {
      const task = database.raw.prepare('SELECT schedule_at FROM task WHERE id = ?').get('task_retention_review') as { schedule_at: string };
      expect(task.schedule_at).toBe('2026-08-15T08:00:00.000Z');
    } finally {
      database.close();
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it.each([
    ['上海午夜单点', '2026-08-14T16:00:00.000Z', null, null, ['2026-08-15']],
    ['跨日右开区间', '2026-08-14T15:00:00.000Z', '2026-08-14T16:00:00.000Z', null, ['2026-08-14']],
    ['跨日覆盖两天', '2026-08-14T15:00:00.000Z', '2026-08-14T16:00:00.001Z', null, ['2026-08-14', '2026-08-15']],
    ['跨月多日', '2026-01-30T16:00:00.000Z', '2026-02-02T16:00:00.000Z', null, ['2026-01-31', '2026-02-01', '2026-02-02']],
    ['跨年', '2025-12-31T15:00:00.000Z', '2026-01-01T17:00:00.000Z', null, ['2025-12-31', '2026-01-01', '2026-01-02']],
    ['起止相等按点事件显示单日', '2026-08-14T16:00:00.000Z', '2026-08-14T16:00:00.000Z', null, ['2026-08-15']],
    ['旧版单一截止时间', null, '2026-08-15T03:00:00.000Z', null, ['2026-08-15']],
    ['坏 start 回退到有效 due', 'not-a-date', '2026-08-15T03:00:00.000Z', null, ['2026-08-15']],
    ['坏 start/due 回退到有效 schedule', 'not-a-start', 'not-a-due', '2026-08-15T15:59:59.999Z', ['2026-08-15']],
    ['旧版 schedule_at 回退', null, null, '2026-08-15T15:59:59.999Z', ['2026-08-15']],
  ])('%s', (_label, startAt, endAt, fallbackAt, expected) => {
    expect(shanghaiCalendarDateKeys(startAt, endAt, fallbackAt)).toEqual(expected);
  });

  it('最大跨度在分配数组前有统一且安全的上限', () => {
    const atLimit = shanghaiCalendarDateKeys('2023-12-31T16:00:00.000Z', '2024-12-31T16:00:00.000Z');
    expect(atLimit).toHaveLength(MAX_SHANGHAI_CALENDAR_SPAN_DAYS);
    expect(atLimit[0]).toBe('2024-01-01');
    expect(atLimit.at(-1)).toBe('2024-12-31');
    expect(() => shanghaiCalendarDateKeys('2023-12-31T16:00:00.000Z', '2025-01-01T16:00:00.000Z'))
      .toThrow('排期跨度超过上限。');
    expect(() => shanghaiCalendarDateKeys('0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z'))
      .toThrow('排期跨度超过上限。');
  });

  it('写入校验允许点事件和上限，拒绝反向及上限加一', () => {
    expect(() => assertShanghaiCalendarPlanRange('2026-08-14T16:00:00.000Z', '2026-08-14T16:00:00.000Z')).not.toThrow();
    expect(() => assertShanghaiCalendarPlanRange('2023-12-31T16:00:00.000Z', '2024-12-31T16:00:00.000Z')).not.toThrow();
    expect(() => assertShanghaiCalendarPlanRange('2026-08-15T16:00:00.000Z', '2026-08-14T16:00:00.000Z'))
      .toThrow('计划完成时间不能早于计划开始时间。');
    expect(() => assertShanghaiCalendarPlanRange('2023-12-31T16:00:00.000Z', '2025-01-01T16:00:00.000Z'))
      .toThrow(`计划时间跨度不能超过 ${MAX_SHANGHAI_CALENDAR_SPAN_DAYS} 个上海自然日。`);
  });

  it('写入校验在 any 绕过时仍拒绝非 string/null 日期', () => {
    expect(() => assertShanghaiCalendarPlanRange(20260815, null)).toThrow('计划开始时间格式不正确。');
    expect(() => assertShanghaiCalendarPlanRange(true, null)).toThrow('计划开始时间格式不正确。');
    expect(() => assertShanghaiCalendarPlanRange(null, 20260815)).toThrow('计划完成时间格式不正确。');
    expect(() => assertShanghaiCalendarPlanRange(null, false)).toThrow('计划完成时间格式不正确。');
  });

  it('三锚点全坏时拒绝，避免静默归到错误日期', () => {
    expect(() => shanghaiCalendarDateKeys('bad-start', 'bad-due', 'bad-schedule')).toThrow('排期时间不可用。');
    expect(() => shanghaiCalendarDateKeys('2026-08-15T01:00:00.000Z', '2026-08-14T01:00:00.000Z', '2026-08-15T02:00:00.000Z'))
      .toThrow('排期区间方向无效。');
  });

  it('Calendar 投影复用同一次解析并清除部分坏字段', () => {
    expect(projectShanghaiCalendarPlan('bad-start-canary', '2026-08-15T03:00:00.000Z', null)).toEqual({
      dayKeys: ['2026-08-15'],
      displayStartAt: null,
      displayDueAt: '2026-08-15T03:00:00.000Z',
      displayScheduleAt: null,
      displayAnchorAt: '2026-08-15T03:00:00.000Z',
    });
    expect(projectShanghaiCalendarPlan('bad-start-canary', 'bad-due-canary', '2026-08-15T15:59:59.999Z')).toEqual({
      dayKeys: ['2026-08-15'],
      displayStartAt: null,
      displayDueAt: null,
      displayScheduleAt: '2026-08-15T15:59:59.999Z',
      displayAnchorAt: '2026-08-15T15:59:59.999Z',
    });
  });
});
