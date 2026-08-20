import { createHash } from 'node:crypto';

export const AUDIT_REPLAY_INTENT = 'audit.ai-decision.replay.v1' as const;

export type ReplayCapabilityBinding = {
  tokenHash: string;
  csrfTokenHash: string;
  origin: 'app://local';
};

/** The current single-owner scope.  It is explicit so replay cannot silently
 * widen to another owner when the storage model grows. */
export const DATA04_OWNER_SCOPE = 'primary' as const;

export type RevisionCanonicalInput = {
  ownerScope: string;
  sourceEventId: string;
  revisionNumber: number;
  revisionKind: string;
  externalId: string;
  sourceType: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  ownerMentioned: number;
  sourceUrl: string | null;
  completeness: string;
  discoveryReason: string;
  metadataJson: string;
  occurredAt: string;
  capturedAt: string;
};

/** One canonical representation used by ingest, migration backfill and
 * replay verification.  Stored metadata is deliberately included as the
 * exact persisted JSON string; it is immutable replay input. */
export function canonicalRevisionPayload(input: RevisionCanonicalInput) {
  return JSON.stringify({
    ownerScope: input.ownerScope,
    sourceEventId: input.sourceEventId,
    revisionNumber: input.revisionNumber,
    revisionKind: input.revisionKind,
    externalId: input.externalId,
    sourceType: input.sourceType,
    conversationId: input.conversationId,
    senderId: input.senderId,
    senderName: input.senderName,
    content: input.content,
    ownerMentioned: input.ownerMentioned,
    sourceUrl: input.sourceUrl,
    completeness: input.completeness,
    discoveryReason: input.discoveryReason,
    metadataJson: input.metadataJson,
    occurredAt: input.occurredAt,
    capturedAt: input.capturedAt,
  });
}

export function canonicalRevisionHash(input: RevisionCanonicalInput) {
  return createHash('sha256').update(canonicalRevisionPayload(input)).digest('hex');
}

export type RevisionSetEntry = {
  sourceEventId: string;
  revisionId: string;
  revisionHash: string;
  sourceOrder: number;
};

export function canonicalRevisionSetPayload(entries: readonly RevisionSetEntry[]) {
  return JSON.stringify(entries.map((entry) => ({
    sourceOrder: entry.sourceOrder,
    sourceEventId: entry.sourceEventId,
    revisionId: entry.revisionId,
    revisionHash: entry.revisionHash,
  })));
}

export function canonicalRevisionSetHash(entries: readonly RevisionSetEntry[]) {
  return createHash('sha256').update(canonicalRevisionSetPayload(entries)).digest('hex');
}
