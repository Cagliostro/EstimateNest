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

const docClient = getDocClient();
const cacheManager = getCacheManager();
/**
 * Broadcast a WebSocket message to all participants in a room.
 * @param event The Lambda event (to extract domainName and stage)
 * @param roomId The room ID
 * @param message The message to broadcast
 * @param excludeConnectionId Optional connection ID to exclude (e.g., sender)
 */
export async function broadcastToRoom(
  event: APIGatewayProxyEvent,
  roomId: string,
  message: WebSocketMessage,
  excludeConnectionId?: string
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

  // Fetch all participants in the room
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
          // Remove connectionId from the participant record
          await docClient.send(
            new UpdateCommand({
              TableName: process.env.PARTICIPANTS_TABLE!,
              Key: {
                roomId: participant.roomId,
                participantId: participant.participantId,
              },
              UpdateExpression: 'REMOVE connectionId SET lastSeenAt = :now',
              ExpressionAttributeValues: {
                ':now': new Date().toISOString(),
              },
            })
          );
          logger.info('Cleaned up stale connection', { roomId: participant.roomId });
          // Invalidate participant cache since participant connection changed
          cacheManager.invalidateParticipants(participant.roomId);
        } catch (cleanupError) {
          logger.error('Failed to clean up stale connection', { error: cleanupError });
        }
      }
    }
  });

  await Promise.allSettled(promises);
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
