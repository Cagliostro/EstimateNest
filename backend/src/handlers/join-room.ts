import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { createAvatarSeed, Participant } from '@estimatenest/shared';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { code } = event.pathParameters || {};
    if (!code) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing room code' }),
      };
    }

    // Look up room by short code
    const codeResult = await docClient.send(new GetCommand({
      TableName: ROOM_CODES_TABLE,
      Key: { shortCode: code.toUpperCase() },
    }));

    if (!codeResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Room not found' }),
      };
    }

    const { roomId, expiresAt } = codeResult.Item;
    if (new Date(expiresAt) < new Date()) {
      return {
        statusCode: 410,
        body: JSON.stringify({ error: 'Room has expired' }),
      };
    }

    // For REST join, we just return room info and a token for WebSocket connection
    const participantId = uuidv4();
    const name = event.queryStringParameters?.name || 'Anonymous';
    const avatarSeed = createAvatarSeed(name);

    const participant: Participant = {
      id: participantId,
      roomId,
      connectionId: 'REST', // placeholder, real connection ID comes from WebSocket
      name,
      avatarSeed,
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      isModerator: false, // determined later via moderator password
    };

    // Store participant (optional for REST join, but we might want to pre‑register)
    await docClient.send(new PutCommand({
      TableName: PARTICIPANTS_TABLE,
      Item: {
        roomId,
        participantId,
        ...participant,
      },
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        participantId,
        name,
        avatarSeed,
        webSocketUrl: process.env.WEBSOCKET_URL || 'wss://example.com',
      }),
    };
  } catch (error) {
    console.error('Join room error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};