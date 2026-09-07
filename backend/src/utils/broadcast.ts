import { PostToConnectionCommand, ApiGatewayManagementApiServiceException } from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { WebSocketMessage } from '@estimatenest/shared';
import { getCacheManager } from './cache';
import { filterPresent } from './participants';
import { createLogger } from './logger';
import { getManagementClient, resolveManagementEndpoint, sendFanOut } from './ws-fanout';

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
  const endpoint = resolveManagementEndpoint(event.requestContext);
  logger.info('Broadcast endpoint', { roomId, endpoint });
  const apiGatewayClient = getManagementClient(endpoint);

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

  const cleanedStaleConnections = await sendFanOut({
    message,
    participants,
    client: apiGatewayClient,
    excludeConnectionId,
  });

  // A cleanup above removed a mapping without anyone else broadcasting the
  // departure. Push one fresh roster to the remaining clients so the ghost
  // heals. isRosterRefresh bounds the cascade to this single extra fan-out.
  if (cleanedStaleConnections.length > 0 && !isRosterRefresh) {
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
  const endpoint = resolveManagementEndpoint(event.requestContext);
  const apiGatewayClient = getManagementClient(endpoint);
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
