import {
  TransactionCanceledException,
  ConditionalCheckFailedException,
  TransactWriteCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDocClient } from './dynamodb';
import { getCacheManager } from './cache';
import { filterPresent, isPresent } from './participants';

const docClient = getDocClient();
const cacheManager = getCacheManager();
const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

/**
 * Moderator handoff grace: when the moderator disconnects, the role is not
 * reassigned immediately — a reconnect of the same participant (e.g. a page
 * reload) must keep it. After this window the oldest present participant is
 * promoted lazily on the next connect/join in the room.
 */
export const MODERATOR_HANDOFF_GRACE_MS = 60_000;

export type ModeratorVacancyResult =
  | { handled: false; reason: 'no-vacancy' }
  | { handled: true; reason: 'moderator-present' }
  | { handled: true; reason: 'promoted'; promotedParticipantId: string }
  | { handled: false; reason: 'no-candidates' };

/**
 * Resolve a pending moderator vacancy. Called after a participant's row has
 * been updated for a WebSocket connect or REST join:
 * - the moderator row being present again clears the vacancy (reload survived
 *   the role even if the grace window already elapsed),
 * - otherwise, once the grace window elapsed, the oldest present participant
 *   is promoted. Promotion and vacancy removal are one atomic transaction, so
 *   concurrent connects can only ever promote one moderator.
 */
export async function handleModeratorVacancy(
  roomId: string,
  connectingParticipantId: string
): Promise<ModeratorVacancyResult> {
  const roomResult = await docClient.send(
    new GetCommand({
      TableName: ROOMS_TABLE,
      Key: { id: roomId, sk: 'META' },
      ConsistentRead: true,
    })
  );
  const vacantAtRaw = roomResult.Item?.moderatorVacantAt as string | undefined;
  if (!vacantAtRaw) {
    return { handled: false, reason: 'no-vacancy' };
  }
  const vacantAt = new Date(vacantAtRaw).getTime();

  // Read participants fresh — cache may predate the vacancy
  cacheManager.invalidateParticipants(roomId);
  const participants = await cacheManager.getParticipantsWithCache(roomId);
  const moderator = participants.find((p) => p.isModerator);

  if (moderator && (isPresent(moderator) || moderator.id === connectingParticipantId)) {
    // The moderator is (back) online — the vacancy is stale, drop it.
    const cleared = await clearVacancy(roomId, vacantAtRaw);
    return cleared
      ? { handled: true, reason: 'moderator-present' }
      : { handled: false, reason: 'no-vacancy' };
  }

  if (Date.now() - vacantAt < MODERATOR_HANDOFF_GRACE_MS) {
    return { handled: false, reason: 'no-vacancy' };
  }

  // Grace expired: promote the oldest present non-moderator participant.
  const present = filterPresent(participants);
  const candidates = present.filter((p) => p.id !== moderator?.id);
  if (candidates.length === 0) {
    return { handled: false, reason: 'no-candidates' };
  }
  const newModerator = candidates.reduce((oldest, current) =>
    new Date(oldest.joinedAt) < new Date(current.joinedAt) ? oldest : current
  );

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ROOMS_TABLE,
              Key: { id: roomId, sk: 'META' },
              UpdateExpression: 'REMOVE moderatorVacantAt',
              ConditionExpression: 'moderatorVacantAt = :observed',
              ExpressionAttributeValues: { ':observed': vacantAtRaw },
            },
          },
          {
            Update: {
              TableName: PARTICIPANTS_TABLE,
              Key: { roomId, participantId: newModerator.id },
              UpdateExpression: 'SET isModerator = :true',
              // The candidate must still be online at commit time — promoting a
              // participant who disconnected in the read→commit window would
              // leave the room with an offline moderator and no vacancy.
              ConditionExpression: 'attribute_exists(connectionId)',
              ExpressionAttributeValues: { ':true': true },
            },
          },
          ...(moderator
            ? [
                {
                  Update: {
                    TableName: PARTICIPANTS_TABLE,
                    Key: { roomId, participantId: moderator.id },
                    UpdateExpression: 'SET isModerator = :false',
                    // Demote only while the ex-moderator is offline: a racing
                    // reconnect must keep the role (the vacancy stays set for
                    // the next resolution). A REST marker does not count as
                    // online — without this escape hatch a stale REST join
                    // (polling client that never reconnects its WebSocket)
                    // would block the vacancy forever.
                    ConditionExpression:
                      'attribute_not_exists(connectionId) OR connectionId = :rest',
                    ExpressionAttributeValues: { ':false': false, ':rest': 'REST' },
                  },
                },
              ]
            : []),
        ],
      })
    );
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      // Lost the race to another connect — vacancy already resolved there.
      return { handled: false, reason: 'no-vacancy' };
    }
    throw error;
  }
  cacheManager.invalidateParticipants(roomId);
  return { handled: true, reason: 'promoted', promotedParticipantId: newModerator.id };
}

async function clearVacancy(roomId: string, observedVacantAt: string): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: ROOMS_TABLE,
        Key: { id: roomId, sk: 'META' },
        UpdateExpression: 'REMOVE moderatorVacantAt',
        ConditionExpression: 'moderatorVacantAt = :observed',
        ExpressionAttributeValues: { ':observed': observedVacantAt },
      })
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw error;
  }
}
