import { Round, getRoomTTL } from '@estimatenest/shared';

/**
 * Map a ROUNDS_TABLE item to the shared Round interface. DynamoDB stores the
 * partition/sort key pair (roomId, roundId); the app-facing id is roundId.
 */
export function mapRoundItem(item: Record<string, unknown>): Round {
  return {
    id: (item.roundId as string) ?? (item.id as string),
    roomId: item.roomId as string,
    title: item.title as string | undefined,
    description: item.description as string | undefined,
    startedAt: item.startedAt as string,
    revealedAt: (item.revealedAt as string | undefined) ?? undefined,
    isRevealed: !!item.isRevealed,
    scheduledRevealAt: (item.scheduledRevealAt as string | undefined) ?? undefined,
  };
}

/**
 * Resolve a row's TTL attribute in epoch seconds. DynamoDB TTL silently never
 * expires rows when expiresAt is an ISO string — a documented production bug
 * in this codebase — so non-numeric values fall back to a fresh room TTL.
 */
export function resolveExpiresAt(expiresAt?: unknown): number {
  return typeof expiresAt === 'number'
    ? expiresAt
    : Math.floor(Date.now() / 1000) + getRoomTTL();
}
