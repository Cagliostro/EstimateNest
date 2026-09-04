import {
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDocClient } from '../utils/dynamodb';
import { createLogger } from '../utils/logger';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { broadcastToRoom } from '../utils/broadcast';
import { getCacheManager } from '../utils/cache';
import { filterPresent } from '../utils/participants';

const docClient = getDocClient();
const cacheManager = getCacheManager();
const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

async function decrementConnectionCount(roomId: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: ROOMS_TABLE,
      Key: { id: roomId, sk: 'META' },
      UpdateExpression: 'ADD connectionCount :dec',
      ExpressionAttributeValues: { ':dec': -1 },
    })
  );
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const logger = createLogger();
  const { connectionId } = event.requestContext;

  try {
    // Find participant by connectionId using GSI
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

    const stale = queryResult.Items?.[0];
    if (!stale) {
      // No participant found with this connectionId, just return success
      return {
        statusCode: 200,
        body: JSON.stringify({ type: 'disconnected', payload: { message: 'Disconnected' } }),
      };
    }

    // Authoritative read: the GSI above is eventually consistent, so a stale
    // disconnect of an old connection can surface a row that already maps a
    // NEWER live connection (the mapping-nuke race). Only act when the row
    // still maps this exact connection.
    const rowResult = await docClient.send(
      new GetCommand({
        TableName: PARTICIPANTS_TABLE,
        Key: { roomId: stale.roomId, participantId: stale.participantId },
        ConsistentRead: true,
      })
    );
    const participant = rowResult.Item;
    if (!participant) {
      // Row expired between the queries — nothing left to do.
      return {
        statusCode: 200,
        body: JSON.stringify({ type: 'disconnected', payload: { message: 'Disconnected' } }),
      };
    }
    const { roomId, participantId } = participant;

    // The consistent read above is the authority: act only when the row still
    // maps THIS connection. A different mapping means a racing reconnect
    // replaced it — balance this connection's count, but leave the live row
    // alone. No mapping at all means this event was already processed (API
    // Gateway redelivery) or a broadcast cleanup removed it — whoever removed
    // the mapping balanced the count, so a decrement here would double it.
    if (participant.connectionId !== connectionId) {
      // A REST marker means the WS mapping was already removed (earlier
      // delivery or broadcast cleanup) and whoever removed it balanced the
      // count — only a racing WS reconnect (different live connectionId)
      // still needs THIS connection's count balanced.
      if (participant.connectionId && participant.connectionId !== 'REST') {
        logger.info('Ignoring stale disconnect (connectionId already replaced)', {
          roomId,
          participantId,
        });
        await decrementConnectionCount(roomId);
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ type: 'disconnected', payload: { message: 'Disconnected' } }),
      };
    }

    // Remove connectionId only if it still maps to THIS connection. A stale
    // disconnect (racing reconnect in the read→update window) must not strip
    // the mapping of a newer live connection.
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: PARTICIPANTS_TABLE,
          Key: { roomId, participantId },
          UpdateExpression: 'REMOVE connectionId SET lastSeenAt = :now',
          ConditionExpression: 'connectionId = :cid AND attribute_exists(connectionId)',
          ExpressionAttributeValues: {
            ':cid': connectionId,
            ':now': new Date().toISOString(),
          },
        })
      );
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException') {
        // Mapping replaced in the read→update window: this connection's
        // $connect was counted, so balance the room count, but leave the
        // row — it maps a live connection — and skip the broadcast.
        logger.info('Ignoring stale disconnect (connectionId already replaced)', {
          roomId,
          participantId,
        });
        await decrementConnectionCount(roomId);
        return {
          statusCode: 200,
          body: JSON.stringify({ type: 'disconnected', payload: { message: 'Disconnected' } }),
        };
      }
      throw error;
    }
    cacheManager.invalidateParticipants(roomId);

    // Atomically decrement connection count on room item
    await decrementConnectionCount(roomId);

    // If the moderator left, mark a vacancy instead of reassigning
    // immediately: a quick reconnect (page reload) must keep the role.
    if (participant.isModerator) {
      const allParticipants = await cacheManager.getParticipantsWithCache(roomId);
      const otherConnectedParticipants = allParticipants.filter(
        (p) => p.id !== participantId && p.connectionId && p.connectionId !== 'REST'
      );

      if (otherConnectedParticipants.length > 0) {
        await docClient.send(
          new UpdateCommand({
            TableName: ROOMS_TABLE,
            Key: { id: roomId, sk: 'META' },
            UpdateExpression: 'SET moderatorVacantAt = :now',
            ExpressionAttributeValues: {
              ':now': new Date().toISOString(),
            },
          })
        );
        logger.info('Moderator disconnected — vacancy marked for lazy handoff', { roomId });
      } else {
        // No other connected participants — keep disconnected participant as moderator
        // They may reconnect later
        logger.info('Moderator disconnected with no reassignment candidates', { roomId });
      }
    }

    // Fetch all participants in the room (cached, invalidated above)
    const participants = await cacheManager.getParticipantsWithCache(roomId);

    // Broadcasts are awaited, not fire-and-forget: the Lambda runtime freezes
    // pending promises when the handler returns, so un-awaited postToConnection
    // calls would stall until the next warm-container invocation — delaying or
    // losing the leave update for the remaining clients.
    try {
      await broadcastToRoom(
        event,
        roomId,
        {
          type: 'participantList',
          payload: { participants: filterPresent(participants) },
        },
        connectionId
      );
    } catch (error) {
      logger.warn('Broadcast participantList failed', { error });
    }

    // Also send a leave notification for clients that track individual leaves
    try {
      await broadcastToRoom(
        event,
        roomId,
        {
          type: 'leave',
          payload: { participantId },
        },
        connectionId
      );
    } catch (error) {
      logger.warn('Broadcast leave failed', { error });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ type: 'disconnected', payload: { message: 'Disconnected' } }),
    };
  } catch (error) {
    logger.error('WebSocket disconnect error', { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ type: 'error', payload: { error: 'Internal server error' } }),
    };
  }
};
