import { describe, expect, it } from 'vitest';
import {
  candidateStateText,
  formatShanghaiDateKey,
  formatShanghaiDateTime,
  formatShanghaiFullDate,
  formatShanghaiPlanRange,
  formatShanghaiTime,
  riskText,
  statusText,
} from './format';

describe('界面文案映射', () => {
  it('为任务、候选和风险提供完整中文标签', () => {
    expect(Object.keys(statusText)).toHaveLength(7);
    expect(candidateStateText.pending).toBe('待确认');
    expect(riskText.high).toBe('高');
  });
});

describe('上海日历日期分组', () => {
  it.each([
    ['00:00', '2026-08-14T16:00:00.000Z', '2026-08-15'],
    ['07:59', '2026-08-14T23:59:00.000Z', '2026-08-15'],
    ['08:00', '2026-08-15T00:00:00.000Z', '2026-08-15'],
    ['跨月', '2026-01-31T16:00:00.000Z', '2026-02-01'],
    ['跨年', '2025-12-31T16:00:00.000Z', '2026-01-01'],
  ])('把上海时间 %s（%s）归入 %s', (_label, value, expected) => {
    expect(formatShanghaiDateKey(value)).toBe(expected);
  });

  it('完整日期也固定使用上海时区，不跟随 renderer 本地时区', () => {
    expect(formatShanghaiFullDate('2026-08-14T16:00:00.000Z')).toContain('2026年8月15日');
    expect(formatShanghaiDateTime('2026-08-14T16:00:00.000Z')).toMatch(/8\D15\D.*00:00/);
    expect(formatShanghaiTime('2026-08-14T16:00:00.000Z')).toBe('00:00');
    expect(formatShanghaiPlanRange('2026-08-14T15:00:00.000Z', '2026-08-14T16:00:00.000Z'))
      .toMatch(/8\D14\D.*23:00 → 8\D15\D.*00:00/);
  });
});
