import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient } from '../utils/dynamodb';
import { createLogger } from '../utils/logger';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { broadcastToRoom } from '../utils/broadcast';
import { validateWebSocketConnectionParams, Room } from '@estimatenest/shared';
import { ZodError } from 'zod';
import { getCacheManager } from '../utils/cache';
import { filterPresent } from '../utils/participants';
import { handleModeratorVacancy } from '../utils/moderator';

const docClient = getDocClient();
const cacheManager = getCacheManager();
const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  const logger = createLogger();
  const { connectionId } = event.requestContext;
  const { roomId, participantId } = event.queryStringParameters || {};

  // Validate roomId and participantId format
  try {
    validateWebSocketConnectionParams({ roomId, participantId });
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          type: 'error',
          payload: { error: 'Invalid roomId or participantId format', details: error.errors },
        }),
      };
    }
    throw error;
  }

  try {
    logger.info('WebSocket connect requestContext', {
      keys: Object.keys(event.requestContext),
      domainName: event.requestContext.domainName,
      stage: event.requestContext.stage,
    });

    // Get room to check maxParticipants limit
    const roomData = await cacheManager.getRoomWithCache(roomId);
    if (!roomData) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          type: 'error',
          payload: { error: 'Room not found' },
        }),
      };
    }
    const room = roomData as Room;
    const maxParticipants = room.maxParticipants || 50;

    // Atomic connection count check and increment on room item
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: ROOMS_TABLE,
          Key: { id: roomId, sk: 'META' },
          UpdateExpression: 'ADD connectionCount :inc',
          ConditionExpression: 'connectionCount < :max OR attribute_not_exists(connectionCount)',
          ExpressionAttributeValues: {
            ':inc': 1,
            ':max': maxParticipants,
          },
        })
      );
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException') {
        return {
          statusCode: 429,
          body: JSON.stringify({
            type: 'error',
            payload: {
              error: `Connection limit exceeded (max ${maxParticipants} connections per room)`,
            },
          }),
        };
      }
      throw error;
    }

    // Update participant with WebSocket connection ID
    await docClient.send(
      new UpdateCommand({
        TableName: PARTICIPANTS_TABLE,
        Key: { roomId, participantId },
        UpdateExpression: 'SET connectionId = :cid, lastSeenAt = :now',
        ExpressionAttributeValues: {
          ':cid': connectionId,
          ':now': new Date().toISOString(),
        },
      })
    );
    // Invalidate participant cache since connectionId updated
    cacheManager.invalidateParticipants(roomId);

    // A pending moderator handoff may now resolve: this connect could be the
    // returning moderator (keeps the role) or trigger the lazy promotion.
    // Lazy and self-healing — never fail the connection on it.
    try {
      const vacancy = await handleModeratorVacancy(roomId, participantId);
      if (vacancy.handled) {
        logger.info('Moderator vacancy resolved via connect', { roomId, reason: vacancy.reason });
      }
    } catch (error) {
      logger.warn('Moderator vacancy resolution failed', { roomId, error });
    }

    // Fetch all participants in the room (cached; refreshed above if a
    // vacancy was resolved)
    const participants = await cacheManager.getParticipantsWithCache(roomId);
    const presentParticipants = filterPresent(participants);

    logger.info('WebSocket connect participants', {
      roomId,
      count: presentParticipants.length,
      isModerator: presentParticipants.filter((p) => p.isModerator).length,
    });

    logger.info('Broadcasting participant list', { roomId });
    // Awaited, not fire-and-forget: the Lambda runtime freezes pending promises
    // when the handler returns, so an un-awaited broadcast would stall until
    // the next warm-container invocation — delaying the join update for the
    // other clients. A broadcast error must not fail the connect.
    try {
      await broadcastToRoom(
        event,
        roomId,
        {
          type: 'participantList',
          payload: { participants: presentParticipants },
        },
        connectionId // exclude the newly connected participant
      );
    } catch (error) {
      logger.warn('Broadcast to room failed', { error });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ type: 'connected', payload: { message: 'Connected' } }),
    };
  } catch (error) {
    logger.error('WebSocket connect error', { error });

    // Handle validation errors
    if (error instanceof ZodError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          type: 'error',
          payload: { error: 'Invalid input format', details: error.errors },
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ type: 'error', payload: { error: 'Internal server error' } }),
    };
  }
};
