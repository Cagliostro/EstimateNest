import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Participant } from '@estimatenest/shared';
import { getDocClient } from './dynamodb';

const docClient = getDocClient();
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

/**
 * A participant row whose WebSocket connection is gone but whose client is
 * still actively polling via REST stays "present": the polling fallback
 * refreshes every 5-30 s, so a stale REST row is a client that left.
 */
export const REST_PRESENT_GRACE_MS = 90_000;

export function isPresent(participant: Participant, now: number = Date.now()): boolean {
  const connectionId = participant.connectionId;
  if (!connectionId) return false;
  if (connectionId !== 'REST') return true; // live WebSocket connection
  const lastSeen = new Date(participant.lastSeenAt).getTime();
  return now - lastSeen < REST_PRESENT_GRACE_MS;
}

export function filterPresent(
  participants: Participant[],
  now: number = Date.now()
): Participant[] {
  return participants.filter((p) => isPresent(p, now));
}

/**
 * Find a participant by connectionId via the ConnectionIdIndex. The index is
 * eventually consistent: a message sent immediately after $connect can miss
 * the brand-new mapping. A miss here would 500 the message and API Gateway
 * closes the connection, feeding reconnect storms (observed in dev: a join
 * raced a concurrent fan-out that had already seen the fresh mapping). Retry
 * briefly before giving up.
 */
export async function findParticipantByConnectionId(
  connectionId: string
): Promise<Participant | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const queryResult = await docClient.send(
      new QueryCommand({
        TableName: PARTICIPANTS_TABLE,
        IndexName: 'ConnectionIdIndex',
        KeyConditionExpression: 'connectionId = :cid',
        ExpressionAttributeValues: {
          ':cid': connectionId,
        },
        Limit: 1,
      })
    );
    if (queryResult.Items?.[0]) {
      return queryResult.Items[0] as Participant;
    }
  }
  return undefined;
}
