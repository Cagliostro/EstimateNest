import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { broadcastToRoom } from '../utils/broadcast';
import { Participant } from '@estimatenest/shared';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  const { connectionId } = event.requestContext;
  const { roomId, participantId } = event.queryStringParameters || {};

  if (!roomId || !participantId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing roomId or participantId' }),
    };
  }

  try {
    console.log('WebSocket connect requestContext keys:', Object.keys(event.requestContext));
    console.log(
      'domainName:',
      event.requestContext.domainName,
      'stage:',
      event.requestContext.stage
    );

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

    // Fetch all participants in the room (consistent read to see our own update)
    const participantsResult = await docClient.send(
      new QueryCommand({
        TableName: PARTICIPANTS_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        ExpressionAttributeValues: {
          ':roomId': roomId,
        },
        ConsistentRead: true,
      })
    );

    const participants = (participantsResult.Items as Participant[]) || [];

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
      body: JSON.stringify({ message: 'Connected' }),
    };
  } catch (error) {
    console.error('WebSocket connect error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
