import { QueryCommand, UpdateCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
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

/**
 * Count the participants that currently hold a WebSocket mapping (ADR-11).
 * 'REST' placeholders never contributed to connectionCount and are filtered
 * out. Consistent read: the self-heal must see committed mappings, not the
 * eventually-consistent view.
 */
async function measureConnectionCount(roomId: string): Promise<number> {
  let count = 0;
  let exclusiveStartKey: QueryCommandOutput['LastEvaluatedKey'];
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: PARTICIPANTS_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        FilterExpression: 'connectionId <> :rest',
        ExpressionAttributeValues: { ':roomId': roomId, ':rest': 'REST' },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );
    count += result.Count ?? 0;
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return count;
}

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  const logger = createLogger();
  // $connect events always carry a connectionId; API Gateway types it optional
  // because $disconnect events do, but this handler only sees $connect.
  const connectionId = event.requestContext.connectionId!;
  const { roomId: rawRoomId, participantId: rawParticipantId } =
    event.queryStringParameters || {};

  // Validate roomId and participantId format — the parsed result is the
  // typed source of truth for the rest of the handler.
  let params: { roomId: string; participantId: string };
  try {
    params = validateWebSocketConnectionParams({
      roomId: rawRoomId,
      participantId: rawParticipantId,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      logger.warn('WebSocket connect rejected: invalid params', {
        connectionId,
        roomId: rawRoomId,
        participantId: rawParticipantId,
        issues: error.issues,
      });
      return {
        statusCode: 400,
        body: JSON.stringify({
          type: 'error',
          payload: { error: 'Invalid roomId or participantId format', details: error.issues },
        }),
      };
    }
    throw error;
  }
  const { roomId, participantId } = params;

  try {
    logger.info('WebSocket connect requestContext', {
      keys: Object.keys(event.requestContext),
      domainName: event.requestContext.domainName,
      stage: event.requestContext.stage,
    });

    // Get room to check maxParticipants limit
    const roomData = await cacheManager.getRoomWithCache(roomId);
    if (!roomData) {
      logger.warn('WebSocket connect rejected: room not found', {
        connectionId,
        roomId,
        participantId,
      });
      return {
        statusCode: 404,
        body: JSON.stringify({
          type: 'error',
          payload: { error: 'Room not found' },
        }),
      };
    }
    const room = roomData as unknown as Room;
    const maxParticipants = room.maxParticipants || 50;

    // Atomic connection count check and increment on room item. If the guarded
    // increment fails, the counter may be drifted (legacy cleanups removed
    // mappings without a matching decrement): measure the real connections,
    // renormalize the counter and retry once within the same request (ADR-11).
    const incrementConnectionCount = () =>
      docClient.send(
        new UpdateCommand({
          TableName: ROOMS_TABLE,
          Key: { id: roomId, sk: 'META' },
          UpdateExpression: 'ADD connectionCount :inc',
          ConditionExpression: 'connectionCount < :max OR attribute_not_exists(connectionCount)',
          ExpressionAttributeValues: {
            ':inc': 1,
            ':max': maxParticipants,
          },
          // Hands the pre-increment room item back with the failed condition,
          // so the drift log can show the old counter value (ADR-11).
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        })
      );

    let measuredConnectionCount: number | undefined;
    let countAcquired = false;
    try {
      await incrementConnectionCount();
      countAcquired = true;
    } catch (error) {
      if ((error as Error).name !== 'ConditionalCheckFailedException') {
        throw error;
      }

      // The document client does not unmarshal exception payloads, so the
      // ALL_OLD item arrives in raw attribute form ({ N: '…' }).
      const rawPreviousCount = (error as { Item?: { connectionCount?: { N?: string } } }).Item
        ?.connectionCount?.N;
      const previousConnectionCount =
        rawPreviousCount !== undefined ? Number(rawPreviousCount) : undefined;

      try {
        measuredConnectionCount = await measureConnectionCount(roomId);
      } catch (measureError) {
        logger.warn('Connection count measurement failed', { roomId, error: measureError });
      }

      if (measuredConnectionCount !== undefined && measuredConnectionCount < maxParticipants) {
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: ROOMS_TABLE,
              Key: { id: roomId, sk: 'META' },
              UpdateExpression: 'SET connectionCount = :measured',
              ExpressionAttributeValues: { ':measured': measuredConnectionCount },
            })
          );
          logger.warn('Renormalized drifted connectionCount', {
            roomId,
            previousConnectionCount,
            connectionCount: measuredConnectionCount,
            maxParticipants,
          });
          await incrementConnectionCount();
          countAcquired = true;
        } catch (healError) {
          if ((healError as Error).name !== 'ConditionalCheckFailedException') {
            throw healError;
          }
          // Another connect won the increment between renormalize and retry —
          // the room is genuinely full now.
        }
      }
    }

    if (!countAcquired) {
      logger.warn('WebSocket connect rejected: connection limit reached', {
        connectionId,
        roomId,
        participantId,
        ...(measuredConnectionCount !== undefined
          ? { connectionCount: measuredConnectionCount }
          : {}),
        maxParticipants,
      });
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
          payload: { error: 'Invalid input format', details: error.issues },
        }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ type: 'error', payload: { error: 'Internal server error' } }),
    };
  }
};
