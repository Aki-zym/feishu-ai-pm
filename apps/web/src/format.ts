import type { CandidateState, RiskLevel, TaskStatus } from './types';

const shanghaiCalendarDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const shanghaiFullDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});

const shanghaiShortDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const shanghaiTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const statusText: Record<TaskStatus, string> = {
  unplanned: '待排期',
  planned: '已排期',
  in_progress: '进行中',
  waiting: '等待中',
  review: '评审中',
  completed: '已完成',
  archived: '已归档',
};

export const recordStateText: Record<'active' | 'invalidated', string> = {
  active: '有效记录',
  invalidated: '已判定非需求',
};

export const candidateStateText: Record<CandidateState, string> = {
  pending: '待确认',
  snoozed: '稍后再议',
  ignored: '已忽略',
  accepted: '已接受',
};

export const riskText: Record<RiskLevel, string> = { low: '低', medium: '中', high: '高' };

export function formatDate(value: string | null, includeTime = true) {
  if (!value) return '未安排';
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(date);
}

export function formatPlanRange(startAt: string | null, dueAt: string | null) {
  if (!startAt && !dueAt) return '未安排';
  if (startAt && dueAt) return `${formatDate(startAt)} → ${formatDate(dueAt)}`;
  return startAt ? `开始 ${formatDate(startAt)}` : `完成 ${formatDate(dueAt)}`;
}

export function formatShanghaiDateKey(value: string) {
  const parts = Object.fromEntries(
    shanghaiCalendarDateFormatter.formatToParts(new Date(value)).map(({ type, value: partValue }) => [type, partValue]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatShanghaiFullDate(value: string) {
  return shanghaiFullDateFormatter.format(new Date(value));
}

export function formatShanghaiDateTime(value: string | null) {
  return value ? shanghaiShortDateTimeFormatter.format(new Date(value)) : '未安排';
}

export function formatShanghaiTime(value: string | null) {
  return value ? shanghaiTimeFormatter.format(new Date(value)) : '未安排';
}

export function formatShanghaiPlanRange(startAt: string | null, dueAt: string | null) {
  if (!startAt && !dueAt) return '未安排';
  if (startAt && dueAt) return `${formatShanghaiDateTime(startAt)} → ${formatShanghaiDateTime(dueAt)}`;
  return startAt ? `开始 ${formatShanghaiDateTime(startAt)}` : `完成 ${formatShanghaiDateTime(dueAt)}`;
}

export function formatFullDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(value));
}
