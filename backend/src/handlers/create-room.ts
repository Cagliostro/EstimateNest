import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { generateShortCode, getRoomTTL, Room } from '@estimatenest/shared';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const {
      moderatorPassword,
      allowAllParticipantsToReveal = false,
      maxParticipants = 50,
      deck = 'fibonacci',
    } = body;

    const roomId = uuidv4();
    const shortCode = generateShortCode();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + getRoomTTL() * 1000).toISOString();

    const room: Room = {
      id: roomId,
      shortCode,
      createdAt: now,
      expiresAt,
      allowAllParticipantsToReveal,
      maxParticipants,
      deck: typeof deck === 'string' ? deck : deck, // TODO: resolve deck object
    };

    // Write room record
    await docClient.send(new PutCommand({
      TableName: ROOMS_TABLE,
      Item: {
        id: roomId,
        sk: 'META',
        ...room,
      },
    }));

    // Write code mapping
    await docClient.send(new PutCommand({
      TableName: ROOM_CODES_TABLE,
      Item: {
        shortCode,
        roomId,
        createdAt: now,
        expiresAt,
      },
    }));

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        shortCode,
        joinUrl: `https://${process.env.DOMAIN_NAME || 'example.com'}/${shortCode}`,
        expiresAt,
      }),
    };
  } catch (error) {
    console.error('Create room error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};