import { describe, expect, it } from 'vitest';
import { classifyRetryFailure, computeRetryDelay, normalizeRetryFailureMetadata, parseRetryAfter, retryFailureMetadataForHttp, RetryCoordinator } from '../src/retry-policy.js';

describe('RUN-02 retry policy', () => {
  it('只接受受控的秒数和未来 HTTP-date，并拒绝恶意或过大值', () => {
    const now = Date.parse('2026-08-16T00:00:00.000Z');
    expect(parseRetryAfter('3', now)).toEqual({ delayMs: 3_000, source: 'seconds' });
    expect(parseRetryAfter('Sun, 16 Aug 2026 00:00:02 GMT', now)).toEqual({ delayMs: 2_000, source: 'http-date' });
    expect(parseRetryAfter('-1', now)).toBeNull();
    expect(parseRetryAfter('999999999', now)).toBeNull();
    expect(parseRetryAfter('1, 2', now)).toBeNull();
    expect(parseRetryAfter('Sun, 15 Aug 2026 23:59:59 GMT', now)).toBeNull();
    expect(parseRetryAfter('1\r\nX-Injected: yes', now)).toBeNull();
    expect(parseRetryAfter('2026-08-16T00:00:02Z', now)).toBeNull();
    expect(parseRetryAfter('Funday, 16 Aug 2026 00:00:02 GMT', now)).toBeNull();
    expect(parseRetryAfter('Mon, 16 Aug 2026 00:00:02 GMT', now)).toBeNull();
    expect(parseRetryAfter('Sun, 31 Feb 2026 00:00:02 GMT', now)).toBeNull();
    expect(parseRetryAfter('Sunday, 16-Aug-26 00:00:02 GMT', now)).toBeNull();
    expect(parseRetryAfter('Sun Aug 16 00:00:02 2026', now)).toBeNull();
  });

  it('只从结构化 HTTP/transport 错误提取共享 cooldown metadata，不解析自由文本', () => {
    expect(retryFailureMetadataForHttp(429, 'openai_compatible')).toEqual({
      category: 'rate_limit', providerKey: 'openai_compatible', cooldownKey: 'openai_compatible', retryable: true,
      retryAt: null, retryAfterMs: null, status: 429, code: 'rate_limit',
    });
    expect(retryFailureMetadataForHttp(503, 'openai_compatible')).toEqual({
      category: 'server_error', providerKey: 'openai_compatible', cooldownKey: 'openai_compatible', retryable: true,
      retryAt: null, retryAfterMs: null, status: 503, code: 'server_error',
    });
    expect(retryFailureMetadataForHttp(429, 'openai_compatible', null, true)).toEqual({
      category: 'rate_limit', providerKey: 'openai_compatible', cooldownKey: 'openai_compatible', retryable: false,
      retryAt: null, retryAfterMs: null, status: 429, code: 'invalid_retry_after',
    });
    expect(retryFailureMetadataForHttp(401, 'openai_compatible')).toEqual({
      category: 'non_retryable', providerKey: 'openai_compatible', cooldownKey: 'openai_compatible', retryable: false,
      retryAt: null, retryAfterMs: null, status: 401, code: 'http_error',
    });
    expect(retryFailureMetadataForHttp(503, 'openai_compatible', 99_999_999)).toMatchObject({
      category: 'server_error', retryable: false, retryAfterMs: null, code: 'invalid_retry_after',
    });
    expect(classifyRetryFailure(Object.assign(new Error('synthetic transport'), { name: 'TypeError' }), 'source.read', true)).toBeNull();
    expect(classifyRetryFailure(Object.assign(new Error('synthetic transport'), { name: 'ECONNRESET' }), 'source.read', true)).toEqual({
      category: 'transport', providerKey: 'source.read', cooldownKey: 'source.read', retryable: true,
      retryAt: null, retryAfterMs: null, status: null, code: 'ECONNRESET',
    });
  });

  it('typed retry signal 对 provider/category/status/key/retryAt 做 fail-closed 校验', () => {
    const now = Date.parse('2026-08-16T00:00:00.000Z');
    const valid = {
      category: 'rate_limit', providerKey: 'provider-a', cooldownKey: 'provider-a', retryable: true,
      retryAt: '2026-08-16T00:00:02.000Z', retryAfterMs: 2_000, status: 429, code: 'rate_limit',
    } as const;
    expect(normalizeRetryFailureMetadata(valid, undefined, now)).toEqual(valid);
    expect(normalizeRetryFailureMetadata({ ...valid, category: 'server_error' }, undefined, now)).toBeNull();
    expect(normalizeRetryFailureMetadata({ ...valid, status: 503 }, undefined, now)).toBeNull();
    expect(normalizeRetryFailureMetadata({ ...valid, providerKey: 'provider-b' }, undefined, now)).toBeNull();
    expect(normalizeRetryFailureMetadata({ ...valid, retryable: undefined }, undefined, now)).toBeNull();
    expect(normalizeRetryFailureMetadata({ ...valid, retryAt: '2026-08-16T00:00:02Z' }, undefined, now)).toBeNull();
    expect(normalizeRetryFailureMetadata({ ...valid, retryAt: '2026-08-16T00:00:02.000Z', code: 'raw provider failure text' }, undefined, now)).toBeNull();
    expect(normalizeRetryFailureMetadata({ ...valid, category: 'transport', status: null, retryAt: null, retryAfterMs: null, code: 'ECONNRESET' }, undefined, now)).toMatchObject({ category: 'transport' });
    expect(normalizeRetryFailureMetadata({
      category: 'rate_limit', providerKey: 'provider-a', cooldownKey: 'provider-a', retryable: false,
      retryAt: null, retryAfterMs: null, status: 429, code: 'invalid_retry_after',
    }, undefined, now)).toMatchObject({ retryable: false, status: 429 });
    expect(normalizeRetryFailureMetadata({
      category: 'non_retryable', providerKey: 'provider-a', cooldownKey: 'provider-a', retryable: false,
      retryAt: null, retryAfterMs: null, status: 401, code: 'http_error',
    }, undefined, now)).toMatchObject({ category: 'non_retryable', retryable: false });
  });

  it('使用单次受控 RNG，在 Retry-After/cooldown 下界之上增加正向 jitter', () => {
    let randomCalls = 0;
    const delay = computeRetryDelay({
      attempt: 3,
      retryAfterMs: 8_000,
      cooldownMs: 9_000,
      options: {
        baseMs: 1_000,
        maxMs: 10_000,
        jitterRatio: 0.2,
        random: () => { randomCalls += 1; return 0.5; },
      },
    });
    expect(randomCalls).toBe(1);
    expect(delay).toBe(9_900);
  });

  it('不同 caller 在同一 Retry-After 下界之上获得不同等待时间且都不提前', () => {
    const first = computeRetryDelay({
      attempt: 1,
      retryAfterMs: 8_000,
      options: { baseMs: 1_000, maxMs: 10_000, jitterRatio: 0.2, random: () => 0.1 },
    });
    const second = computeRetryDelay({
      attempt: 1,
      retryAfterMs: 8_000,
      options: { baseMs: 1_000, maxMs: 10_000, jitterRatio: 0.2, random: () => 0.9 },
    });
    expect(first).toBeGreaterThanOrEqual(8_000);
    expect(second).toBeGreaterThan(first);
  });

  it('在可控时钟下共享 provider cooldown，并可确定性推进', () => {
    let now = 1_000;
    const coordinator = new RetryCoordinator({ now: () => now, random: () => 0.5, baseMs: 100 });
    expect(coordinator.nextDelay('provider-a', 1, 2_000)).toBe(2_200);
    expect(coordinator.cooldownMs('provider-a')).toBe(2_000);
    now += 1_000;
    expect(coordinator.cooldownMs('provider-a')).toBe(1_000);
    now += 1_000;
    expect(coordinator.cooldownMs('provider-a')).toBe(0);
  });

  it('没有 Retry-After 时也用计算出的退避建立共享 cooldown，阻止第二 caller 立即缩短等待', () => {
    let now = 1_000;
    const coordinator = new RetryCoordinator({ now: () => now, random: () => 0.5, baseMs: 100, jitterRatio: 0 });
    const firstDelay = coordinator.nextDelay('provider-a', 2);
    expect(firstDelay).toBe(200);
    expect(coordinator.cooldownMs('provider-a')).toBe(200);

    const secondDelay = coordinator.nextDelay('provider-a', 1);
    expect(secondDelay).toBe(200);
    expect(coordinator.cooldownMs('provider-a')).toBe(200);
    now += 200;
    expect(coordinator.cooldownMs('provider-a')).toBe(0);
  });
});
