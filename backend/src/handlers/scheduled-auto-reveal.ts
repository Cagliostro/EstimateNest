import { ScanCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient } from '../utils/dynamodb';
import { createLogger } from '../utils/logger';
import { getCacheManager } from '../utils/cache';
import { filterPresent } from '../utils/participants';
import { getManagementClient, sendFanOut } from '../utils/ws-fanout';
import { mapRoundItem, resolveExpiresAt } from '../utils/rounds';
import { WebSocketMessage, Round, Vote, Participant } from '@estimatenest/shared';

const docClient = getDocClient();
const cacheManager = getCacheManager();

const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;
const WEBSOCKET_URL = process.env.WEBSOCKET_URL!;

/**
 * Get the WebSocket API management endpoint from WEBSOCKET_URL.
 * WEBSOCKET_URL format: wss://{apiId}.execute-api.{region}.amazonaws.com/{stage}
 * Convert to: https://{apiId}.execute-api.{region}.amazonaws.com/{stage}
 * If custom domain is used, we still need the execute-api endpoint.
 * For simplicity, assume WEBSOCKET_URL is the execute-api URL.
 */
function getWebSocketApiEndpoint(): string {
  if (!WEBSOCKET_URL) {
    throw new Error('WEBSOCKET_URL environment variable is required');
  }
  // Replace wss:// with https://
  return WEBSOCKET_URL.replace('wss://', 'https://');
}

/**
 * Broadcast a roundUpdate message to all participants in a room. Reuses the
 * hardened fan-out shared with broadcastToRoom: stale connections (410/403)
 * are cleaned under the connect-grace guard, the room's connection count is
 * balanced, and the remaining clients get one roster refresh so no ghost
 * lingers after a cleanup.
 */
async function broadcastRoundRevealed(
  round: Round,
  votes: Vote[],
  participants: Participant[]
): Promise<void> {
  const logger = createLogger();
  const endpoint = getWebSocketApiEndpoint();
  const apiGatewayClient = getManagementClient(endpoint);

  const message: WebSocketMessage = {
    type: 'roundUpdate',
    payload: { round, votes },
  };

  logger.info('Broadcasting roundUpdate', { participantCount: participants.length });

  const cleanedParticipants = await sendFanOut({
    message,
    participants,
    client: apiGatewayClient,
  });

  // Whoever removes a mapping must inform the room: push one roster to the
  // remaining clients so the ghost heals (the cleaned rows are gone from DDB,
  // so filtering the local list is equivalent to a fresh fetch).
  if (cleanedParticipants.length > 0) {
    try {
      const survivors = participants.filter(
        (p) => !cleanedParticipants.some((c) => c.id === p.id)
      );
      await sendFanOut({
        message: {
          type: 'participantList',
          payload: { participants: filterPresent(survivors) },
        },
        participants: survivors,
        client: apiGatewayClient,
      });
    } catch (error) {
      logger.warn('Roster refresh broadcast failed', { error });
    }
  }
}

/**
 * Scheduled Lambda to reveal rounds where scheduledRevealAt has passed.
 * Runs every minute via EventBridge rule.
 */
export const handler = async (): Promise<void> => {
  const logger = createLogger();
  logger.info('Scheduled auto-reveal handler started');
  const now = new Date().toISOString();

  // Validate required environment variables
  if (!WEBSOCKET_URL) {
    throw new Error('WEBSOCKET_URL environment variable is required');
  }

  try {
    // Scan for rounds where scheduledRevealAt <= now and isRevealed = false
    // Note: Scan is acceptable because number of active rounds is small.
    // In production, consider adding a GSI on scheduledRevealAt for efficiency.
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: ROUNDS_TABLE,
        FilterExpression:
          'isRevealed = :false AND attribute_exists(scheduledRevealAt) AND scheduledRevealAt <= :now',
        ExpressionAttributeValues: {
          ':false': false,
          ':now': now,
        },
        Limit: 100, // safety limit
      })
    );

    const rounds = scanResult.Items || [];
    logger.info('Found rounds pending auto-reveal', { count: rounds.length });

    for (const roundItem of rounds) {
      const roomId = roundItem.roomId;
      const roundId = roundItem.roundId || roundItem.id;
      logger.info('Processing auto-reveal for round', { roundId, roomId });

      // Update round as revealed
      await docClient.send(
        new UpdateCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId },
          UpdateExpression:
            'SET isRevealed = :true, revealedAt = :now, expiresAt = :exp REMOVE scheduledRevealAt',
          ExpressionAttributeValues: {
            ':true': true,
            ':now': now,
            ':exp': resolveExpiresAt(roundItem.expiresAt),
          },
        })
      );

      // Invalidate cache
      cacheManager.invalidateActiveRound(roomId);

      // Delete the ACTIVE coordination item: the round is no longer active and
      // a stale ACTIVE pointing at a revealed round must never resurface as
      // "the active round" (parity with the manual reveal path).
      await docClient.send(
        new DeleteCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId: 'ACTIVE' },
        })
      );

      // Fetch votes for this round
      const votesResult = await docClient.send(
        new QueryCommand({
          TableName: VOTES_TABLE,
          KeyConditionExpression: 'roundId = :roundId',
          ExpressionAttributeValues: {
            ':roundId': roundId,
          },
        })
      );
      const votes = (votesResult.Items || []) as unknown as Vote[];

      // Fetch participants to broadcast (need connectionIds)
      const participantsResult = await docClient.send(
        new QueryCommand({
          TableName: PARTICIPANTS_TABLE,
          KeyConditionExpression: 'roomId = :roomId',
          ExpressionAttributeValues: {
            ':roomId': roomId,
          },
        })
      );
      const participants = (participantsResult.Items || []) as unknown as Participant[];

      // Create Round object for broadcasting (hard override before mapping:
      // the scheduled reveal just committed these fields)
      const roundData = mapRoundItem({
        ...roundItem,
        isRevealed: true,
        revealedAt: now,
        scheduledRevealAt: undefined,
      });

      // Broadcast round update to all participants
      await broadcastRoundRevealed(roundData, votes, participants);

      logger.info('Round auto-revealed via scheduled Lambda and broadcasted', { roundId });
    }

    logger.info('Scheduled auto-reveal handler completed');
  } catch (error) {
    logger.error('Scheduled auto-reveal error', { error });
    throw error;
  }
};
