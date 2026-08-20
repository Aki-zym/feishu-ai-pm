export const SHANGHAI_TIMEZONE = 'Asia/Shanghai' as const;
export const MAX_SHANGHAI_CALENDAR_SPAN_DAYS = 366;
export const SHANGHAI_CALENDAR_OMITTED_WARNING = '部分异常排期未显示。';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type ShanghaiDayWindow = {
  date: string;
  startAt: string;
  endAt: string;
};

export type ShanghaiCalendarPlanProjection = {
  dayKeys: string[];
  displayStartAt: string | null;
  displayDueAt: string | null;
  displayScheduleAt: string | null;
  displayAnchorAt: string;
};

function utcMidnightMillis(year: number, month: number, day: number) {
  const instant = new Date(0);
  instant.setUTCFullYear(year, month, day);
  instant.setUTCHours(0, 0, 0, 0);
  return instant.getTime();
}

function parseInstant(value: string | null) {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function sanitizedInstant(millis: number | null) {
  return millis === null ? null : new Date(millis).toISOString();
}

export function shanghaiDayWindow(value: string | number | Date = Date.now()): ShanghaiDayWindow {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error('无法计算上海自然日：时间格式无效。');
  const shifted = new Date(instant.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const startMillis = utcMidnightMillis(year, month, day) - SHANGHAI_OFFSET_MS;
  const nextStartMillis = utcMidnightMillis(year, month, day + 1) - SHANGHAI_OFFSET_MS;
  if (!Number.isSafeInteger(startMillis) || !Number.isSafeInteger(nextStartMillis)) {
    throw new Error('无法计算上海自然日：时间超出安全范围。');
  }
  return {
    date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    startAt: new Date(startMillis).toISOString(),
    endAt: new Date(nextStartMillis).toISOString(),
  };
}

function calendarDayCount(startMillis: number, endMillis: number) {
  if (startMillis > endMillis) throw new Error('排期区间方向无效。');
  if (startMillis === endMillis) return 1;

  const firstStart = Date.parse(shanghaiDayWindow(startMillis).startAt);
  const lastStart = Date.parse(shanghaiDayWindow(endMillis - 1).startAt);
  const difference = lastStart - firstStart;
  const dayCount = difference / DAY_MS + 1;
  if (!Number.isSafeInteger(firstStart) || !Number.isSafeInteger(lastStart)
    || !Number.isSafeInteger(difference) || !Number.isSafeInteger(dayCount) || dayCount < 1) {
    throw new Error('排期跨度无效。');
  }
  return dayCount;
}

export function assertShanghaiCalendarPlanRange(startAt: unknown, endAt: unknown) {
  if (startAt !== null && typeof startAt !== 'string') throw new Error('计划开始时间格式不正确。');
  if (endAt !== null && typeof endAt !== 'string') throw new Error('计划完成时间格式不正确。');
  const startMillis = parseInstant(startAt);
  const endMillis = parseInstant(endAt);
  if (startAt && startMillis === null) throw new Error('计划开始时间格式不正确。');
  if (endAt && endMillis === null) throw new Error('计划完成时间格式不正确。');
  if (startMillis === null || endMillis === null) return;
  if (startMillis > endMillis) throw new Error('计划完成时间不能早于计划开始时间。');
  if (calendarDayCount(startMillis, endMillis) > MAX_SHANGHAI_CALENDAR_SPAN_DAYS) {
    throw new Error(`计划时间跨度不能超过 ${MAX_SHANGHAI_CALENDAR_SPAN_DAYS} 个上海自然日。`);
  }
}

export function shanghaiCalendarDateKeys(
  startAt: string | null,
  endAt: string | null,
  fallbackAt: string | null = null,
) {
  return projectShanghaiCalendarPlan(startAt, endAt, fallbackAt).dayKeys;
}

export function projectShanghaiCalendarPlan(
  startAt: string | null,
  endAt: string | null,
  fallbackAt: string | null = null,
): ShanghaiCalendarPlanProjection {
  const startMillis = parseInstant(startAt);
  const endMillis = parseInstant(endAt);
  const fallbackMillis = parseInstant(fallbackAt);
  const displayStartAt = sanitizedInstant(startMillis);
  const displayDueAt = sanitizedInstant(endMillis);
  const displayScheduleAt = sanitizedInstant(fallbackMillis);

  if (startMillis !== null && endMillis !== null) {
    const dayCount = calendarDayCount(startMillis, endMillis);
    if (dayCount > MAX_SHANGHAI_CALENDAR_SPAN_DAYS) throw new Error('排期跨度超过上限。');
    const firstDay = shanghaiDayWindow(startMillis);
    const firstStart = Date.parse(firstDay.startAt);
    const dayKeys = Array.from({ length: dayCount }, (_, index) => (
      shanghaiDayWindow(firstStart + index * DAY_MS).date
    ));
    return {
      dayKeys,
      displayStartAt,
      displayDueAt,
      displayScheduleAt,
      displayAnchorAt: displayStartAt!,
    };
  }

  const anchor = [startMillis, endMillis, fallbackMillis]
    .find((value): value is number => value !== null);
  if (anchor === undefined) throw new Error('排期时间不可用。');
  return {
    dayKeys: [shanghaiDayWindow(anchor).date],
    displayStartAt,
    displayDueAt,
    displayScheduleAt,
    displayAnchorAt: new Date(anchor).toISOString(),
  };
}
