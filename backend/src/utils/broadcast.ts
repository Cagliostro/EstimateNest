import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient } from './dynamodb';
import { createLogger } from './logger';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  ApiGatewayManagementApiServiceException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { WebSocketMessage } from '@estimatenest/shared';
import { getCacheManager } from './cache';
import { filterPresent } from './participants';

const docClient = getDocClient();
const cacheManager = getCacheManager();
/**
 * Broadcast a WebSocket message to all participants in a room.
 * @param event The Lambda event (to extract domainName and stage)
 * @param roomId The room ID
 * @param message The message to broadcast
 * @param excludeConnectionId Optional connection ID to exclude (e.g., sender)
 * @param isRosterRefresh Internal: this call was spawned as the roster refresh
 *   after a stale-connection cleanup and must not chain another refresh.
 */
export async function broadcastToRoom(
  event: APIGatewayProxyEvent,
  roomId: string,
  message: WebSocketMessage,
  excludeConnectionId?: string,
  isRosterRefresh = false
): Promise<void> {
  const logger = createLogger();
  const { domainName, stage, apiId } = event.requestContext;
  // Determine region from domainName (if execute-api domain) or from environment
  let region = process.env.AWS_REGION || 'eu-central-1';
  if (domainName.includes('.execute-api.')) {
    const match = domainName.match(/execute-api\.([a-z0-9-]+)\.amazonaws\.com/);
    if (match) region = match[1];
  }
  const endpoint = `https://${apiId}.execute-api.${region}.amazonaws.com/${stage}`;
  logger.info('Broadcast endpoint', { roomId, region, stage });
  const apiGatewayClient = new ApiGatewayManagementApiClient({ endpoint });

  // Fetch all participants in the room (cached)
  const participants = await cacheManager.getParticipantsWithCache(roomId);
  if (!message.type) {
    logger.error('Broadcast message missing type field');
  }
  const roundIdFromPayload =
    message.type === 'roundUpdate'
      ? (message.payload as { round?: { id: string } }).round?.id
      : undefined;
  logger.info('Broadcasting message', {
    type: message.type,
    roundId: roundIdFromPayload,
    roomId,
    participantCount: participants.length,
  });
  const activeParticipants = participants.filter(
    (p) => p.connectionId && p.connectionId !== 'REST' && p.connectionId !== excludeConnectionId
  );
  logger.info('Active connections to send to', { count: activeParticipants.length });

  // Set when this fan-out removed a stale connectionId mapping: whoever
  // removes a mapping must inform the room, or the remaining clients keep a
  // ghost — the departed client's $disconnect is racing or already done and
  // will no-op against the empty mapping, so no leave broadcast ever fires.
  let cleanedStaleConnection = false;

  // Send message to each active WebSocket connection
  const promises = activeParticipants.map(async (participant) => {
    try {
      await apiGatewayClient.send(
        new PostToConnectionCommand({
          ConnectionId: participant.connectionId,
          Data: JSON.stringify(message),
        })
      );
    } catch (error) {
      logger.warn('Failed to send message to connection', { error });

      // If the connection is gone (410) or forbidden (403), clean up the stale connection ID
      const isStaleConnection =
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 410 ||
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 403;

      if (
        isStaleConnection &&
        participant.connectionId &&
        participant.roomId &&
        participant.participantId
      ) {
        try {
          // Remove connectionId only if it still maps the dead connection — a
          // racing reconnect may have mapped this row to a live connection and
          // must not be stripped (mapping-nuke race).
          await docClient.send(
            new UpdateCommand({
              TableName: process.env.PARTICIPANTS_TABLE!,
              Key: {
                roomId: participant.roomId,
                participantId: participant.participantId,
              },
              UpdateExpression: 'REMOVE connectionId SET lastSeenAt = :now',
              ConditionExpression: 'connectionId = :cid',
              ExpressionAttributeValues: {
                ':cid': participant.connectionId,
                ':now': new Date().toISOString(),
              },
            })
          );
          logger.info('Cleaned up stale connection', { roomId: participant.roomId });
          // Invalidate participant cache since participant connection changed
          cacheManager.invalidateParticipants(participant.roomId);
          cleanedStaleConnection = true;
        } catch (cleanupError) {
          // ConditionalCheckFailed: the row maps a newer live connection now —
          // nothing to clean up. Logged below to avoid noise.
          if ((cleanupError as Error).name !== 'ConditionalCheckFailedException') {
            logger.error('Failed to clean up stale connection', { error: cleanupError });
          }
        }
      }
    }
  });

  await Promise.allSettled(promises);

  // A cleanup above removed a mapping without anyone else broadcasting the
  // departure. Push one fresh roster to the remaining clients so the ghost
  // heals. isRosterRefresh bounds the cascade to this single extra fan-out.
  if (cleanedStaleConnection && !isRosterRefresh) {
    try {
      const freshParticipants = await cacheManager.getParticipantsWithCache(roomId);
      await broadcastToRoom(
        event,
        roomId,
        {
          type: 'participantList',
          payload: { participants: filterPresent(freshParticipants) },
        },
        excludeConnectionId,
        true
      );
    } catch (error) {
      logger.warn('Roster refresh broadcast failed', { error });
    }
  }
}

/**
 * Send a WebSocket message to a specific connection.
 * @param event The Lambda event (to extract domainName and stage)
 * @param connectionId The target connection ID
 * @param message The message to send
 */
export async function sendToConnection(
  event: APIGatewayProxyEvent,
  connectionId: string,
  message: WebSocketMessage
): Promise<void> {
  const logger = createLogger();
  const { domainName, stage, apiId } = event.requestContext;
  // Determine region from domainName (if execute-api domain) or from environment
  let region = process.env.AWS_REGION || 'eu-central-1';
  if (domainName.includes('.execute-api.')) {
    const match = domainName.match(/execute-api\.([a-z0-9-]+)\.amazonaws\.com/);
    if (match) region = match[1];
  }
  const endpoint = `https://${apiId}.execute-api.${region}.amazonaws.com/${stage}`;
  const apiGatewayClient = new ApiGatewayManagementApiClient({ endpoint });
  if (!message.type) {
    logger.error('SendToConnection message missing type field');
  }

  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await apiGatewayClient.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify(message),
        })
      );
      logger.info('Successfully sent to connection', { attempt });
      return;
    } catch (error) {
      lastError = error;
      const isGoneException =
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 410;
      logger.warn('Failed to send to connection', { attempt, error });

      if (isGoneException && attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const delayMs = 100 * Math.pow(2, attempt - 1);
        logger.info('Connection gone, retrying', { delayMs });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      // Not a gone exception or no more retries
      break;
    }
  }

  logger.warn('Failed to send message after all attempts', { maxRetries, error: lastError });
  // Re-throw the last error so the caller can handle it
  throw lastError;
}
