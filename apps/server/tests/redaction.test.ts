import { describe, expect, it } from 'vitest';
import {
  REDACTION_SCHEMA_VERSION,
  redactDiagnosticRecord,
  redactDiagnosticText,
  redactDiagnosticValue,
} from '../src/redaction.js';

describe('递归 fail-closed 诊断脱敏', () => {
  it('递归处理嵌套对象、数组、凭证键、正文和外部标识', () => {
    const fixture = {
      status: 'failed',
      details: {
        authorization: 'Bearer synthetic-auth-32',
        id: 'synthetic-unknown-id-32',
        providerRequestId: 'synthetic-provider-request-id-32',
        items: [
          { clientSecret: 'synthetic-client-secret-32' },
          { responseBody: 'synthetic-response-body-32' },
          { chatId: 'synthetic-external-chat-32' },
          { details: 770032, headers: false },
        ],
      },
      prompt: 'synthetic-prompt-body-32',
      unknownProviderField: 'synthetic-unknown-32',
      unknownNumeric: 320032,
      externalNumericId: 880032,
      attempts: 3,
      failed: true,
    };

    const redacted = redactDiagnosticRecord(fixture);
    const text = JSON.stringify(redacted);
    expect(redacted.redactionSchemaVersion).toBe(REDACTION_SCHEMA_VERSION);
    for (const canary of [
      'synthetic-auth-32',
      'synthetic-unknown-id-32',
      'synthetic-provider-request-id-32',
      'synthetic-client-secret-32',
      'synthetic-response-body-32',
      'synthetic-external-chat-32',
      'synthetic-prompt-body-32',
      'synthetic-unknown-32',
      '320032',
      '880032',
      '770032',
    ]) expect(text).not.toContain(canary);
    expect(text).toContain('<redacted>');
    expect(text).toContain('<redacted-body>');
    expect(text).toContain('"attempts":3');
    expect(text).toContain('"failed":true');
  });

  it('类型化 schema 对安全键类型错配和未知数组 primitive 保持 fail-closed', () => {
    const redacted = redactDiagnosticValue({
      message: 320101,
      summary: true,
      taskId: false,
      attempts: 'synthetic-attempts-string-32',
      failed: 320102,
      error: 320104,
      logs: true,
      details: {
        items: [
          'synthetic-array-string-32',
          320103,
          true,
          null,
          { message: 'ordinary nested diagnostic remains readable' },
        ],
        externalNumericId: 880032,
      },
      health: 'synthetic-container-string-32',
      url: 'synthetic-opaque-url-32',
      notice: 'ordinary top-level diagnostic remains readable',
      trace_id: 'internal-trace-32',
      count: 3,
      ok: false,
    }) as Record<string, unknown>;

    expect(redacted).toMatchObject({
      message: '<redacted>',
      summary: '<redacted>',
      taskId: '<redacted>',
      attempts: '<redacted>',
      failed: '<redacted>',
      error: '<redacted>',
      logs: '<redacted>',
      health: '<redacted>',
      url: '<redacted>',
      notice: 'ordinary top-level diagnostic remains readable',
      trace_id: 'internal-trace-32',
      count: 3,
      ok: false,
    });
    const details = redacted.details as { items: unknown[]; [key: string]: unknown };
    expect(details.items.slice(0, 4)).toEqual(['<redacted>', '<redacted>', '<redacted>', '<redacted>']);
    expect(details.items[4]).toEqual({ message: 'ordinary nested diagnostic remains readable' });
    expect(details.externalNumericId).toBeUndefined();
    expect(Object.entries(details)).toContainEqual([expect.stringMatching(/^redactedKey\d+$/), '<redacted>']);
    const text = JSON.stringify(redacted);
    for (const canary of [
      'synthetic-attempts-string-32',
      'synthetic-array-string-32',
      '320101',
      '320102',
      '320103',
      '320104',
      '880032',
      'synthetic-container-string-32',
      'synthetic-opaque-url-32',
    ]) expect(text).not.toContain(canary);
  });

  it('hostile key 统一替换为短编号，不碰撞覆盖或污染 prototype', () => {
    const hostile: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const hostileKeys = [
      'synthetic-unknown-key-canary-32',
      'authorization_synthetic-credential-key-canary-32',
      'provider_request_id_synthetic-external-key-canary-32',
      '__proto__',
      'constructor',
      'prototype',
      'redactedKey1',
    ];
    for (const [index, key] of hostileKeys.entries()) hostile[key] = index === 3
      ? { polluted: 'synthetic-prototype-pollution-canary-32' }
      : `synthetic-hostile-value-${index}-32`;

    const valueOutput = redactDiagnosticValue({ details: hostile }, { maxEntries: 20, maxStringLength: 16 }) as Record<string, unknown>;
    const recordOutput = redactDiagnosticRecord(hostile, { maxEntries: 20, maxStringLength: 16 });
    const textOutput = redactDiagnosticText(hostile);
    const text = JSON.stringify([valueOutput, recordOutput, textOutput]);
    for (const canary of [
      ...hostileKeys.slice(0, 3),
      'synthetic-prototype-pollution-canary-32',
      'synthetic-hostile-value-',
    ]) expect(text).not.toContain(canary);
    expect(text).not.toContain('"__proto__"');
    expect(text).not.toContain('"constructor"');
    expect(text).not.toContain('"prototype"');
    expect(text).not.toContain('"redactedKey1"');

    const details = valueOutput.details as Record<string, unknown>;
    const outputKeys = Object.keys(details);
    expect(outputKeys).toHaveLength(hostileKeys.length);
    expect(new Set(outputKeys).size).toBe(hostileKeys.length);
    expect(outputKeys.every((key) => /^redactedKey\d+$/.test(key))).toBe(true);
    expect(Object.getPrototypeOf(details)).toBeNull();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('超长 hostile key 与 key 碰撞仍受输出预算约束', () => {
    const longKey = `synthetic-long-key-canary-32-${'x'.repeat(100_000)}`;
    const collisionFixture = {
      details: {
        [longKey]: 'synthetic-long-key-value-32',
        eventType: 'first controlled event',
        event_type: 'second controlled event',
      },
    };
    const redacted = redactDiagnosticValue(collisionFixture, { maxEntries: 6, maxStringLength: 8 }) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('synthetic-long-key-canary-32');
    expect(text).not.toContain('synthetic-long-key-value-32');
    expect(text.length).toBeLessThan(300);
    expect(() => JSON.parse(text)).not.toThrow();

    const details = redacted.details as Record<string, unknown>;
    expect(Object.values(details)).toEqual(expect.arrayContaining([
      '<redacted>',
      'first co',
      'second c',
    ]));
    expect(Object.keys(details)).toHaveLength(3);
    expect(new Set(Object.keys(details)).size).toBe(3);
    expect(details.eventType).toBe('first co');
  });

  it('安全处理 summary/message 中的 Bearer、Authorization、URL query 和本机路径', () => {
    const samples = [
      'request failed Authorization: Bearer synthetic-header-32',
      'request failed with Bearer synthetic-bearer-32',
      'callback https://example.invalid/oauth?code=synthetic-query-32&state=fixture#fragment',
      'Windows C:\\SyntheticUser\\private\\fixture.txt',
      'POSIX /home/synthetic-user/private/fixture.txt',
      'UNC \\\\synthetic-host\\private-share\\fixture.txt',
      'file URL file:///C:/SyntheticFileProfile32/private/fixture.txt',
      'Cookie: session=synthetic-cookie-first-32; preference=synthetic-cookie-second-32; theme=dark',
      'Set-Cookie: session=synthetic-set-cookie-32; Path=/; HttpOnly\nordinary diagnostic remains readable',
      'cookie=session=synthetic-cookie-equals-first-32; preference=synthetic-cookie-equals-second-32',
      '"Set-Cookie"="session=synthetic-set-cookie-equals-32; Path=/; HttpOnly"\nsecond ordinary line remains readable',
      'response body: synthetic-provider-body-32',
    ];
    const output = samples.map((sample) => redactDiagnosticText(sample)).join('\n');
    for (const canary of [
      'synthetic-header-32',
      'synthetic-bearer-32',
      'synthetic-query-32',
      'SyntheticUser',
      'synthetic-user',
      'synthetic-host',
      'SyntheticFileProfile32',
      'synthetic-cookie-first-32',
      'synthetic-cookie-second-32',
      'synthetic-set-cookie-32',
      'synthetic-cookie-equals-first-32',
      'synthetic-cookie-equals-second-32',
      'synthetic-set-cookie-equals-32',
      'synthetic-provider-body-32',
    ]) expect(output).not.toContain(canary);
    expect(output).toContain('<url>');
    expect(output).toContain('<local-path>');
    expect(output).toContain('ordinary diagnostic remains readable');
    expect(output).toContain('second ordinary line remains readable');
  });

  it('url 字段只接受可确认 URL，普通 message 继续保留安全说明', () => {
    const redacted = redactDiagnosticValue({
      message: 'ordinary provider timeout remains readable',
      details: {
        url: 'synthetic-opaque-secret-32',
        metadata: { url: 'https://example.invalid/path?code=synthetic-url-field-query-32' },
        items: [{ url: 'file:///C:/SyntheticUrlField32/private/fixture.txt' }],
      },
    });
    const text = JSON.stringify(redacted);
    expect(text).toContain('ordinary provider timeout remains readable');
    expect(text).not.toContain('synthetic-opaque-secret-32');
    expect(text).not.toContain('synthetic-url-field-query-32');
    expect(text).not.toContain('SyntheticUrlField32');
    expect(text).toContain('<redacted>');
    expect(text).toContain('<url>');
    expect(text).toContain('<local-path>');
  });

  it('处理 Error cause、循环、深度和非普通对象时仍可 JSON 序列化', () => {
    const cause = new Error('cause Bearer synthetic-cause-32');
    const error = new Error('top https://example.invalid/fail?token=synthetic-error-query-32', { cause });
    const circular: Record<string, unknown> = { message: 'safe envelope' };
    circular.details = circular;
    const value = redactDiagnosticValue({
      details: { error, metadata: circular, url: new URL('https://example.invalid/path?secret=synthetic-url-object-32') },
    }, { maxDepth: 6, maxEntries: 30 });
    const text = JSON.stringify(value);
    expect(text).not.toContain('synthetic-cause-32');
    expect(text).not.toContain('synthetic-error-query-32');
    expect(text).not.toContain('synthetic-url-object-32');
    expect(text).toContain('top <url>');
    expect(text).toContain('cause Bearer <redacted>');
    expect(text).toContain('<circular>');
    expect(text).toContain('<url>');
  });

  it('Error 只读取安全 data descriptor，accessor 不执行且普通 Error 仍可诊断', () => {
    let accessorReads = 0;
    const accessorError = new Error();
    for (const property of ['name', 'message', 'cause']) {
      Object.defineProperty(accessorError, property, {
        configurable: true,
        get() {
          accessorReads += 1;
          if (property === 'message') throw new Error('synthetic-error-getter-thrown-32');
          return `synthetic-error-${property}-getter-32`;
        },
      });
    }
    const ordinary = new Error(
      'ordinary error Bearer synthetic-ordinary-error-token-32',
      { cause: new Error('ordinary cause remains readable') },
    );

    const value = redactDiagnosticValue({ details: { errors: [accessorError, ordinary] } });
    const text = JSON.stringify(value);
    expect(accessorReads).toBe(0);
    expect(text).not.toContain('synthetic-error-');
    expect(text).not.toContain('synthetic-ordinary-error-token-32');
    expect(text).toContain('<redacted-accessor>');
    expect(text).toContain('"name":"Error"');
    expect(text).toContain('ordinary error Bearer <redacted>');
    expect(text).toContain('ordinary cause remains readable');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('URL 使用受控 intrinsic，不执行子类 getter，并拒绝危险 scheme、opaque 值和 revoked Proxy', () => {
    let accessorReads = 0;
    let fieldAccessorReads = 0;
    class AccessorUrl extends URL {
      override get protocol() {
        accessorReads += 1;
        return 'javascript:';
      }

      override get href() {
        accessorReads += 1;
        return 'synthetic-url-href-getter-32';
      }

      override toString() {
        accessorReads += 1;
        return 'synthetic-url-tostring-32';
      }
    }
    const subclassUrl = new AccessorUrl('https://example.invalid/path?secret=synthetic-url-subclass-32');
    const revocable = Proxy.revocable(new URL('https://example.invalid/revoked?secret=synthetic-revoked-url-32'), {});
    revocable.revoke();
    const accessorEnvelope: Record<string, unknown> = {};
    Object.defineProperty(accessorEnvelope, 'url', {
      enumerable: true,
      get() {
        fieldAccessorReads += 1;
        throw new Error('synthetic-url-field-accessor-32');
      },
    });

    const value = redactDiagnosticValue({
      details: {
        url: subclassUrl,
        metadata: {
          url: new URL('file:///C:/SyntheticUrlAccessor32/private/fixture.txt'),
          items: [
            new URL('data:text/plain,synthetic-data-url-32'),
            new URL('javascript:synthetic-javascript-url-32'),
            revocable.proxy,
            accessorEnvelope,
          ],
        },
      },
    });
    const text = JSON.stringify(value);
    expect(accessorReads).toBe(0);
    expect(fieldAccessorReads).toBe(0);
    for (const canary of [
      'synthetic-url-href-getter-32',
      'synthetic-url-tostring-32',
      'synthetic-url-subclass-32',
      'SyntheticUrlAccessor32',
      'synthetic-data-url-32',
      'synthetic-javascript-url-32',
      'synthetic-revoked-url-32',
      'synthetic-url-field-accessor-32',
    ]) expect(text).not.toContain(canary);
    expect(text).toContain('<url>');
    expect(text).toContain('<local-path>');
    expect(text).toContain('<redacted>');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('数组通过 own data descriptor 限量读取，不调用 getter、slice 或 species', () => {
    let indexReads = 0;
    let sliceReads = 0;
    let speciesReads = 0;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get() {
        indexReads += 1;
        return 'synthetic-array-index-getter-32';
      },
    });
    Object.defineProperty(accessorArray, 'slice', {
      get() {
        sliceReads += 1;
        throw new Error('synthetic-shadowed-slice-32');
      },
    });

    class SpeciesArray<T> extends Array<T> {
      static override get [Symbol.species](): ArrayConstructor {
        speciesReads += 1;
        throw new Error('synthetic-array-species-32');
      }
    }
    const speciesArray = new SpeciesArray<unknown>();
    speciesArray[0] = { message: 'ordinary species array diagnostic remains readable' };
    const sparseArray = new Array<unknown>(1_000_000);
    sparseArray[49] = 'synthetic-sparse-array-value-32';

    const value = redactDiagnosticValue({
      details: {
        items: accessorArray,
        errors: speciesArray,
        metadata: { items: sparseArray },
      },
    }, { maxEntries: 200 });
    const text = JSON.stringify(value);
    expect(indexReads).toBe(0);
    expect(sliceReads).toBe(0);
    expect(speciesReads).toBe(0);
    for (const canary of [
      'synthetic-array-index-getter-32',
      'synthetic-shadowed-slice-32',
      'synthetic-array-species-32',
      'synthetic-sparse-array-value-32',
    ]) expect(text).not.toContain(canary);
    expect(text).toContain('<redacted-accessor>');
    expect(text).toContain('<redacted-hole>');
    expect(text).toContain('<truncated:999950>');
    expect(text).toContain('ordinary species array diagnostic remains readable');
    expect(text.length).toBeLessThan(5_000);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('Proxy 与 revoked Proxy 不触发 ownKeys/descriptor trap，所有入口均不抛且不泄漏', () => {
    let ownKeysReads = 0;
    let descriptorReads = 0;
    const trapped = new Proxy({ message: 'synthetic-proxy-source-32' }, {
      ownKeys() {
        ownKeysReads += 1;
        throw new Error('synthetic-proxy-ownkeys-32');
      },
      getOwnPropertyDescriptor() {
        descriptorReads += 1;
        return {
          configurable: true,
          enumerable: true,
          value: 'synthetic-proxy-descriptor-32',
          writable: true,
        };
      },
    });
    const revocable = Proxy.revocable({ summary: 'synthetic-revoked-proxy-32' }, {});
    revocable.revoke();

    const outputs = [
      redactDiagnosticValue(trapped),
      redactDiagnosticValue(revocable.proxy),
      redactDiagnosticRecord(trapped),
      redactDiagnosticRecord(revocable.proxy),
      redactDiagnosticText(trapped),
      redactDiagnosticText(revocable.proxy),
      redactDiagnosticValue(Symbol('synthetic-symbol-32')),
      redactDiagnosticValue(320105n),
      redactDiagnosticValue(() => 'synthetic-function-32'),
    ];
    expect(ownKeysReads).toBe(0);
    expect(descriptorReads).toBe(0);
    const text = JSON.stringify(outputs);
    for (const canary of [
      'synthetic-proxy-source-32',
      'synthetic-proxy-ownkeys-32',
      'synthetic-proxy-descriptor-32',
      'synthetic-revoked-proxy-32',
      'synthetic-symbol-32',
      '320105',
      'synthetic-function-32',
    ]) expect(text).not.toContain(canary);
    expect(text).toContain('<redacted>');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('set_cookie 自由文本字段保持保守整值脱敏', () => {
    const value = redactDiagnosticValue({
      details: {
        set_cookie: 'session=synthetic-set-cookie-field-first-32; preference=synthetic-set-cookie-field-second-32',
      },
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain('synthetic-set-cookie-field-first-32');
    expect(text).not.toContain('synthetic-set-cookie-field-second-32');
    expect(text).toContain('<redacted>');
  });

  it('使用单次调用共享节点预算限制深层宽树输出', () => {
    const wideTree = (depth: number): Record<string, unknown> => depth === 0
      ? { message: 'bounded leaf' }
      : { items: Array.from({ length: 8 }, () => ({ details: wideTree(depth - 1) })) };
    const redacted = redactDiagnosticValue({ details: wideTree(5) }, { maxDepth: 20, maxEntries: 40 });
    const text = JSON.stringify(redacted);
    expect(text).toContain('<max-entries>');
    expect(text.length).toBeLessThan(4_000);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('未知字段占位和 Error 固定字段同样消耗共享输出预算', () => {
    const unknowns = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `unknown_${index}`,
      `synthetic-budget-unknown-${index}-32`,
    ]));
    const redacted = redactDiagnosticValue({
      details: {
        ...unknowns,
        error: new Error('synthetic-budget-error-32'),
      },
    }, { maxEntries: 6 });
    const text = JSON.stringify(redacted);
    expect(text).toContain('<max-entries>');
    expect(text).not.toContain('synthetic-budget-unknown-');
    expect(text).not.toContain('synthetic-budget-error-32');
    expect(text.length).toBeLessThan(500);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
