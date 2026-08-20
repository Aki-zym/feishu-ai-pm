import { types as nodeTypes } from 'node:util';
import { URL as NodeUrl } from 'node:url';
import { sanitizeUntrustedText } from './integrations/llm.js';

export const REDACTION_SCHEMA_VERSION = '1';

const REDACTED = '<redacted>';
const REDACTED_BODY = '<redacted-body>';
const REDACTED_PATH = '<local-path>';
const REDACTED_URL = '<url>';
const REDACTED_ACCESSOR = '<redacted-accessor>';
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 500;
const MAX_CONTAINER_ENTRIES = 50;
const DEFAULT_MAX_STRING_LENGTH = 500;
const GENERATED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const GENERATED_HASH = /^[0-9a-f]{32,64}$/iu;

type JsonPrimitive = string | number | boolean | null;
export type RedactedValue = JsonPrimitive | RedactedValue[] | { [key: string]: RedactedValue };

type RedactionOptions = {
  maxDepth?: number;
  maxEntries?: number;
  maxStringLength?: number;
};

type DiagnosticSchema = 'text' | 'identifier' | 'nullable-identifier' | 'number' | 'boolean' | 'container' | 'diagnostic' | 'count-or-container' | 'url';
type SafeDescriptor =
  | { kind: 'data'; value: unknown }
  | { kind: 'accessor' }
  | { kind: 'missing' }
  | { kind: 'blocked' };
type DiagnosticKeyPolicy = {
  kind: 'schema' | 'credential' | 'body' | 'path' | 'external-identifier' | 'unknown';
  schema?: DiagnosticSchema;
  canonicalKey?: string;
};
type OutputKeyState = {
  used: Set<string>;
  forbiddenDynamicKeys: Set<string>;
  nextRedactedKey: number;
};

const credentialKey = /(?:^|_)(?:authorization|proxy_authorization|cookie|set_cookie|password|passwd|passphrase|secret|client_secret|app_secret|token|access_token|refresh_token|id_token|api_key|apikey|private_key|signing_key|code_verifier|authorization_code)(?:$|_)/u;
const bodyKeys = new Set(['body', 'content', 'prompt', 'response', 'request', 'messages', 'input', 'output', 'request_body', 'response_body', 'payload', 'raw', 'raw_payload', 'transcript', 'chat_text', 'document_text']);
const pathKeys = new Set(['path', 'file_path', 'root_path', 'absolute_path', 'workspace_path']);
const externalIdentifierKeys = new Set([
  'external_id', 'open_id', 'union_id', 'user_id', 'chat_id', 'conversation_id',
  'message_id', 'tenant_id', 'tenant_key', 'document_id', 'provider_request_id',
]);

const textKeys = new Set([
  'summary', 'message', 'reason', 'last_error', 'notice', 'category', 'level',
  'event_type', 'status', 'state', 'stage', 'scope', 'mode', 'type', 'source_type',
  'error_type', 'error_code', 'diagnostic_code', 'code', 'failure_type',
  'detail_status', 'target_kind', 'provider', 'model', 'adapter', 'integration',
  'outcome', 'completeness', 'fallback_mode', 'structured_mode', 'correction_type',
  'operation', 'visibility', 'job_type', 'prompt_version', 'database',
  'generated_at', 'checked_at', 'created_at', 'updated_at', 'occurred_at',
  'timestamp', 'feishu', 'classifier', 'workspace', 'app_version', 'source', 'relation_fingerprint',
  'diagnostic_bundle_version', 'redaction_schema_version',
]);

const identifierKeys = new Set([
  'operation_id', 'request_id', 'trace_id', 'parent_span_id', 'span_id', 'job_id', 'task_id', 'candidate_id', 'source_event_id',
  'thread_id', 'reference_id', 'proposal_id', 'accepted_task_id',
  'target_candidate_id', 'runtime_job_id', 'input_hash', 'redaction_schema_version',
]);

const numberKeys = new Set([
  'count', 'sources', 'candidates', 'tasks', 'attempts', 'max_attempts',
  'http_status', 'status_code', 'latency_ms', 'input_char_count', 'confidence',
  'retention_days', 'people_discovered', 'groups_discovered', 'person_count',
  'changed_people', 'group_count', 'changed_groups', 'source_count', 'entry_count',
  'selected_count', 'failures', 'pages', 'discovered', 'new_targets', 'events',
  'detail_failures', 'minutes', 'attempt', 'failed_jobs', 'pending_jobs',
  'duration_ms', 'available_bytes', 'stale_sources', 'observed_sources', 'active_cooldowns',
]);

const booleanKeys = new Set([
  'ok', 'checked', 'changed', 'is_data_request', 'used_fallback',
  'raw_messages_included', 'secrets_included', 'absolute_paths_included',
  'live_connections_enabled', 'external_connections', 'expires_at_present',
  'bot_supplement_started', 'owner_open_id_present', 'tenant_present',
  'sender_id_present', 'failed', 'failed_batch', 'rebuild', 'skipped', 'truncated',
  'packaged', 'real_tenant_validated', 'listener_started', 'deduplicated',
  'stale',
]);

const containerKeys = new Set([
  'context', 'details', 'metadata', 'errors', 'items', 'counts', 'health',
  'configuration', 'integrations', 'recent_errors', 'privacy', 'job', 'release',
  'fields', 'headers', 'readiness', 'reasons', 'dependencies', 'summaries', 'limits',
  'recent_events', 'sync', 'runtime', 'database', 'backoff', 'queue', 'token', 'disk',
  'runner', 'listener', 'freshness',
]);

const countOrContainerKeys = new Set(['logs', 'decisions', 'corrections']);
const diagnosticKeys = new Set(['error', 'cause']);

const urlToString = NodeUrl.prototype.toString;
const urlProtocolGetter = Object.getOwnPropertyDescriptor(NodeUrl.prototype, 'protocol')?.get;

function normalizedKey(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replace(/[-\s]+/gu, '_').toLowerCase();
}

function schemaForNormalizedKey(normalized: string): DiagnosticSchema | undefined {
  if (normalized === 'build_identity') return 'nullable-identifier';
  if (normalized === 'url') return 'url';
  if (diagnosticKeys.has(normalized)) return 'diagnostic';
  if (countOrContainerKeys.has(normalized)) return 'count-or-container';
  if (containerKeys.has(normalized)) return 'container';
  if (textKeys.has(normalized)) return 'text';
  if (identifierKeys.has(normalized)) return 'identifier';
  if (numberKeys.has(normalized)) return 'number';
  if (booleanKeys.has(normalized)) return 'boolean';
  return undefined;
}

function canonicalOutputKey(normalized: string) {
  if (['operation_id', 'request_id', 'trace_id', 'parent_span_id', 'span_id', 'app_version', 'build_identity', 'redaction_schema_version'].includes(normalized)) return normalized;
  return normalized.replace(/_([a-z0-9])/gu, (_, character: string) => character.toUpperCase());
}

function diagnosticKeyPolicy(key: string): DiagnosticKeyPolicy {
  const normalized = normalizedKey(key);
  if (credentialKey.test(normalized)) return { kind: 'credential' };
  if (bodyKeys.has(normalized)) return { kind: 'body' };
  if (pathKeys.has(normalized)) return { kind: 'path' };
  if (externalIdentifierKeys.has(normalized)) return { kind: 'external-identifier' };
  const schema = schemaForNormalizedKey(normalized);
  return schema
    ? { kind: 'schema', schema, canonicalKey: canonicalOutputKey(normalized) }
    : { kind: 'unknown' };
}

function nextRedactedOutputKey(state: OutputKeyState) {
  let key: string;
  do {
    key = `redactedKey${state.nextRedactedKey}`;
    state.nextRedactedKey += 1;
  } while (state.used.has(key) || state.forbiddenDynamicKeys.has(key));
  state.used.add(key);
  return key;
}

function safeOutputKey(policy: DiagnosticKeyPolicy, state: OutputKeyState) {
  const canonical = policy.kind === 'schema' ? policy.canonicalKey : undefined;
  if (canonical && !state.used.has(canonical)) {
    state.used.add(canonical);
    return canonical;
  }
  return nextRedactedOutputKey(state);
}

function isProxy(value: object) {
  try {
    return nodeTypes.isProxy(value);
  } catch {
    return true;
  }
}

function isNativeError(value: object) {
  try {
    return nodeTypes.isNativeError(value);
  } catch {
    return false;
  }
}

function findSafeDescriptor(value: object, property: string): SafeDescriptor {
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (isProxy(current)) return { kind: 'blocked' };
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        return 'value' in descriptor
          ? { kind: 'data', value: descriptor.value }
          : { kind: 'accessor' };
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return { kind: 'missing' };
  } catch {
    return { kind: 'blocked' };
  }
}

function safePositiveInteger(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function redactTextSource(source: string, maxLength: number) {
  const redacted = source
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/giu, REDACTED)
    .replace(/\b(?:cookie|set-cookie)["']?\s*[:=][^\r\n]*/giu, `cookie=${REDACTED}`)
    .replace(/\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer|basic)?\s*[^\s"',;]+["']?/giu, `authorization=${REDACTED}`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/giu, `Bearer ${REDACTED}`)
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu, REDACTED)
    .replace(/\b(?:client[_ -]?secret|app[_ -]?secret|password|passphrase|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|api[_ -]?key|code[_ -]?verifier|authorization[_ -]?code)["']?\s*[:=]\s*["']?[^\s"',;]+["']?/giu, REDACTED)
    .replace(/\b(?:request\s+body|response\s+body|body|prompt|response|payload|content)["']?\s*[:=]\s*[^\r\n]*/giu, REDACTED_BODY)
    .replace(/\bfile:\/\/[^\s"'<>]+/giu, REDACTED_PATH)
    .replace(/https?:\/\/[^\s"'<>]+/giu, REDACTED_URL)
    .replace(/(?:\\\\[^\\\s"']+\\[^\s"']+|[A-Za-z]:[\\/][^\r\n"']*)/gu, REDACTED_PATH)
    .replace(/(^|[\s("'`=])\/(?:[^/\s"'`]+\/)*[^/\s"'`]+/gu, `$1${REDACTED_PATH}`)
    .replace(/\s+/gu, ' ')
    .trim();
  // Use the same SEC-02 projection as model/output text before applying the
  // public length bound, preventing recognizable prefixes at a cut boundary.
  return sanitizeUntrustedText(redacted, maxLength);
}

function errorTextSource(value: object): string {
  const descriptor = findSafeDescriptor(value, 'message');
  return descriptor.kind === 'data' && typeof descriptor.value === 'string'
    ? descriptor.value
    : descriptor.kind === 'missing'
      ? ''
      : REDACTED;
}

function redactErrorTextDescriptor(descriptor: SafeDescriptor, fallback: string, maxStringLength: number): RedactedValue {
  if (descriptor.kind === 'missing') return fallback;
  if (descriptor.kind === 'accessor') return REDACTED_ACCESSOR;
  return descriptor.kind === 'data' && typeof descriptor.value === 'string'
    ? redactDiagnosticText(descriptor.value, maxStringLength)
    : REDACTED;
}

function redactDiagnosticIdentifier(value: string, maxLength: number) {
  // Identifier-typed fields are server-owned references (request/operation
  // IDs and hashes). Preserve their canonical generated shape while routing
  // any other text through the shared untrusted projection.
  if (GENERATED_UUID.test(value) || GENERATED_HASH.test(value)) return value.slice(0, maxLength);
  return redactDiagnosticText(value, maxLength);
}

/**
 * Redact a human-readable error or summary without invoking accessors or
 * arbitrary coercion. Any unexpected classification failure stays closed.
 */
export function redactDiagnosticText(value: unknown, maxLength = DEFAULT_MAX_STRING_LENGTH) {
  try {
    const safeMaxLength = safePositiveInteger(maxLength, DEFAULT_MAX_STRING_LENGTH);
    let source: string;
    if (typeof value === 'string') source = value;
    else if (value !== null && typeof value === 'object' && !isProxy(value) && isNativeError(value)) source = errorTextSource(value);
    else if (value === null || value === undefined) source = '';
    else source = '<unsupported-value>';
    return redactTextSource(source, safeMaxLength);
  } catch {
    return REDACTED;
  }
}

function redactParsedUrl(value: string): RedactedValue {
  try {
    const parsed = new NodeUrl(value);
    if (!urlProtocolGetter) return REDACTED;
    const protocol = Reflect.apply(urlProtocolGetter, parsed, []) as unknown;
    if (protocol === 'http:' || protocol === 'https:') return REDACTED_URL;
    if (protocol === 'file:') return REDACTED_PATH;
  } catch {
    // Invalid and opaque URL values are not diagnostic metadata.
  }
  return REDACTED;
}

function redactUrlObject(value: object): RedactedValue | undefined {
  if (isProxy(value)) return REDACTED;
  try {
    const serialized = Reflect.apply(urlToString, value, []) as unknown;
    return typeof serialized === 'string' ? redactParsedUrl(serialized) : REDACTED;
  } catch {
    return undefined;
  }
}

function redactUrlValue(value: unknown): RedactedValue {
  if (typeof value === 'string') return redactParsedUrl(value);
  if (value !== null && typeof value === 'object') return redactUrlObject(value) ?? REDACTED;
  return REDACTED;
}

function unknownValueSummary(value: unknown): RedactedValue {
  if (value !== null && typeof value === 'object') {
    try {
      return Array.isArray(value) ? '<redacted-array>' : '<redacted-object>';
    } catch {
      return REDACTED;
    }
  }
  return REDACTED;
}

/**
 * Recursively produce a JSON-safe diagnostic value. The schema controls both
 * key and value type; arrays never inherit their parent's primitive schema.
 */
export function redactDiagnosticValue(value: unknown, options: RedactionOptions = {}): RedactedValue {
  try {
    const maxDepth = safePositiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
    const maxEntries = safePositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    const maxContainerEntries = Math.min(MAX_CONTAINER_ENTRIES, maxEntries);
    const maxStringLength = safePositiveInteger(options.maxStringLength, DEFAULT_MAX_STRING_LENGTH);
    const seen = new WeakSet<object>();
    let remainingEntries = maxEntries;
    const consumeEntry = () => {
      if (remainingEntries <= 0) return false;
      remainingEntries -= 1;
      return true;
    };

    const visit = (current: unknown, depth: number, schema?: DiagnosticSchema): RedactedValue => {
      try {
        if (!consumeEntry()) return '<max-entries>';
        if (depth > maxDepth) return '<max-depth>';

        if (schema === 'url') return redactUrlValue(current);
        if (typeof current === 'string') {
          return schema === 'identifier' || schema === 'nullable-identifier'
            ? redactDiagnosticIdentifier(current, maxStringLength)
            : schema === 'text' || schema === 'diagnostic'
              ? redactDiagnosticText(current, maxStringLength)
            : REDACTED;
        }
        if (typeof current === 'number') {
          return (schema === 'number' || schema === 'count-or-container') && Number.isFinite(current)
            ? current
            : REDACTED;
        }
        if (typeof current === 'boolean') return schema === 'boolean' ? current : REDACTED;
        if (current === null || current === undefined) return schema === 'nullable-identifier' ? null : REDACTED;
        if (typeof current !== 'object') return REDACTED;
        if (isProxy(current)) return REDACTED;

        const urlValue = redactUrlObject(current);
        if (urlValue !== undefined) return urlValue;

        if (isNativeError(current)) {
          if (seen.has(current)) return '<circular>';
          seen.add(current);
          const result: { [key: string]: RedactedValue } = Object.create(null) as { [key: string]: RedactedValue };
          const name = findSafeDescriptor(current, 'name');
          const message = findSafeDescriptor(current, 'message');
          const cause = findSafeDescriptor(current, 'cause');
          if (!consumeEntry()) return { truncatedEntries: '<max-entries>' };
          result.name = redactErrorTextDescriptor(name, 'Error', maxStringLength);
          if (!consumeEntry()) {
            result.truncatedEntries = '<max-entries>';
            return result;
          }
          result.message = redactErrorTextDescriptor(message, '', maxStringLength);
          if (cause.kind === 'data') result.cause = visit(cause.value, depth + 1, 'diagnostic');
          else if (cause.kind === 'accessor') result.cause = consumeEntry() ? REDACTED_ACCESSOR : '<max-entries>';
          else if (cause.kind === 'blocked') result.cause = consumeEntry() ? REDACTED : '<max-entries>';
          return result;
        }

        if (Array.isArray(current)) {
          if (seen.has(current)) return '<circular>';
          seen.add(current);
          const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length');
          if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') return REDACTED;
          const length = lengthDescriptor.value;
          const visibleLength = Math.min(length, maxContainerEntries);
          const items: RedactedValue[] = [];
          let stoppedForBudget = false;
          for (let index = 0; index < visibleLength; index += 1) {
            if (remainingEntries <= 0) {
              items.push('<max-entries>');
              stoppedForBudget = true;
              break;
            }
            const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
            if (!descriptor) {
              consumeEntry();
              items.push('<redacted-hole>');
            } else if (!('value' in descriptor)) {
              consumeEntry();
              items.push(REDACTED_ACCESSOR);
            } else {
              // Container membership is not an element schema. Primitive array
              // values therefore remain closed unless a future schema says otherwise.
              items.push(visit(descriptor.value, depth + 1));
            }
          }
          if (length > maxContainerEntries && !stoppedForBudget) {
            items.push(consumeEntry() ? `<truncated:${length - maxContainerEntries}>` : '<max-entries>');
          }
          return items;
        }

        if (seen.has(current)) return '<circular>';
        seen.add(current);
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) return '<unsupported-object>';
        const ownKeys = Reflect.ownKeys(current);
        const output: { [key: string]: RedactedValue } = Object.create(null) as { [key: string]: RedactedValue };
        const outputKeyState: OutputKeyState = {
          used: new Set(),
          forbiddenDynamicKeys: new Set(ownKeys.filter((key): key is string => typeof key === 'string')),
          nextRedactedKey: 1,
        };
        const inspectedKeyCount = Math.min(ownKeys.length, maxContainerEntries);
        for (let index = 0; index < inspectedKeyCount; index += 1) {
          if (remainingEntries <= 0) {
            output.truncatedEntries = '<max-entries>';
            break;
          }
          const childKey = ownKeys[index];
          if (typeof childKey !== 'string') {
            consumeEntry();
            continue;
          }
          const keyPolicy = diagnosticKeyPolicy(childKey);
          const outputKey = safeOutputKey(keyPolicy, outputKeyState);
          const descriptor = Object.getOwnPropertyDescriptor(current, childKey);
          if (!descriptor) {
            consumeEntry();
            output[outputKey] = REDACTED;
          } else if (keyPolicy.kind === 'credential' || keyPolicy.kind === 'external-identifier') {
            consumeEntry();
            output[outputKey] = REDACTED;
          } else if (keyPolicy.kind === 'body') {
            consumeEntry();
            output[outputKey] = REDACTED_BODY;
          } else if (keyPolicy.kind === 'path') {
            consumeEntry();
            output[outputKey] = REDACTED_PATH;
          } else if (!('value' in descriptor)) {
            consumeEntry();
            output[outputKey] = REDACTED_ACCESSOR;
          } else {
            const childSchema = keyPolicy.schema;
            const structured = descriptor.value !== null && typeof descriptor.value === 'object';
            const schemaAllowsStructure = childSchema === 'container'
              || childSchema === 'diagnostic'
              || childSchema === 'count-or-container'
              || childSchema === 'url';
            if (childSchema && (!structured || schemaAllowsStructure)) {
              output[outputKey] = visit(descriptor.value, depth + 1, childSchema);
            } else if (consumeEntry()) {
              output[outputKey] = unknownValueSummary(descriptor.value);
            }
          }
        }
        if (ownKeys.length > maxContainerEntries) {
          if (consumeEntry()) output.truncatedFields = ownKeys.length - maxContainerEntries;
          else output.truncatedEntries = '<max-entries>';
        }
        return output;
      } catch {
        return REDACTED;
      }
    };

    return visit(value, 0, value !== null && typeof value === 'object' ? 'container' : undefined);
  } catch {
    return REDACTED;
  }
}

export function redactDiagnosticRecord(value: Record<string, unknown>, options: RedactionOptions = {}) {
  try {
    const redacted = redactDiagnosticValue(value, options);
    return redacted && !Array.isArray(redacted) && typeof redacted === 'object'
      ? { ...redacted, redactionSchemaVersion: REDACTION_SCHEMA_VERSION }
      : { value: redacted, redactionSchemaVersion: REDACTION_SCHEMA_VERSION };
  } catch {
    return { value: REDACTED, redactionSchemaVersion: REDACTION_SCHEMA_VERSION };
  }
}
