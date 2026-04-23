import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { broadcastToRoom } from '../utils/broadcast';
import { validateWebSocketConnectionParams, Room } from '@estimatenest/shared';
import { ZodError } from 'zod';
import { getCacheManager } from '../utils/cache';

const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(client);
const cacheManager = getCacheManager();
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
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
    console.log('WebSocket connect requestContext keys:', Object.keys(event.requestContext));
    console.log(
      'domainName:',
      event.requestContext.domainName,
      'stage:',
      event.requestContext.stage
    );

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

    // Check connection limit (respects room's maxParticipants setting)
    const activeParticipantsResult = await docClient.send(
      new QueryCommand({
        TableName: PARTICIPANTS_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        FilterExpression: 'attribute_exists(connectionId) AND connectionId <> :rest',
        ExpressionAttributeValues: {
          ':roomId': roomId,
          ':rest': 'REST',
        },
        Select: 'COUNT',
      })
    );

    if (activeParticipantsResult.Count >= maxParticipants) {
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

    // Fetch all participants in the room (cached, invalidated just above)
    const participants = await cacheManager.getParticipantsWithCache(roomId);

    console.log(
      'WebSocket connect participants:',
      participants.map((p) => ({
        participantId: p.id,
        name: p.name,
        connectionId: p.connectionId,
        isModerator: p.isModerator,
      }))
    );

    console.log(
      `Broadcasting participant list to room ${roomId}, excluding connection ${connectionId}`
    );
    // Broadcast updated participant list to everyone else in the room (fire-and-forget)
    broadcastToRoom(
      event,
      roomId,
      {
        type: 'participantList',
        payload: { participants },
      },
      connectionId // exclude the newly connected participant
    ).catch((broadcastError) => {
      console.warn('Broadcast to room failed:', broadcastError);
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ type: 'connected', payload: { message: 'Connected' } }),
    };
  } catch (error) {
    console.error('WebSocket connect error:', error);

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
