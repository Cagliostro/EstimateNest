import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  generateShortCode,
  getRoomTTL,
  Room,
  Participant,
  CardDeck,
  validateCreateRoomRequest,
  parseDeckInput,
  createAvatarSeed,
} from '@estimatenest/shared';
import { ZodError } from 'zod';
import { hashPassword } from '../utils/password';

const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(client);

const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Create room handler invoked', { path: event.path, httpMethod: event.httpMethod });
  console.log('Environment variables:', {
    ROOMS_TABLE: process.env.ROOMS_TABLE,
    ROOM_CODES_TABLE: process.env.ROOM_CODES_TABLE,
    PARTICIPANTS_TABLE: process.env.PARTICIPANTS_TABLE,
    DOMAIN_NAME: process.env.DOMAIN_NAME,
  });
  try {
    const rawBody = event.body ? JSON.parse(event.body) : {};
    let validatedBody;
    try {
      validatedBody = validateCreateRoomRequest(rawBody);
    } catch (error) {
      console.error('Request validation failed:', error);
      const origin = event.headers.origin || event.headers.Origin;
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin || '*',
      };

      if (error instanceof ZodError || (error as Error).name === 'ZodError') {
        const zodError = error as { errors?: Array<{ path: string[]; message: string }> };
        const details = zodError.errors
          ? zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
          : ['Validation failed'];
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'Invalid request parameters',
            details,
          }),
        };
      }

      throw error;
    }

    const {
      allowAllParticipantsToReveal = false,
      maxParticipants = 50,
      deck = 'fibonacci',
      autoRevealEnabled = true,
      autoRevealCountdownSeconds = 3,
      moderatorPassword,
    } = validatedBody;

    const roomId = uuidv4();
    const shortCode = generateShortCode();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + getRoomTTL() * 1000).toISOString();

    const hasPassword = !!moderatorPassword;

    let resolvedDeck: CardDeck;
    try {
      resolvedDeck = parseDeckInput(deck);
    } catch (parseError) {
      const origin = event.headers.origin || event.headers.Origin;
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin || '*',
        },
        body: JSON.stringify({
          error: parseError instanceof Error ? parseError.message : 'Invalid deck value',
        }),
      };
    }

    const room: Room = {
      id: roomId,
      shortCode,
      createdAt: now,
      expiresAt,
      allowAllParticipantsToReveal,
      maxParticipants,
      autoRevealEnabled,
      autoRevealCountdownSeconds,
      deck: resolvedDeck,
    };

    if (moderatorPassword) {
      room.moderatorPassword = hashPassword(moderatorPassword);
    }

    await docClient.send(
      new PutCommand({
        TableName: ROOMS_TABLE,
        Item: {
          ...room,
          sk: 'META',
        },
      })
    );

    await docClient.send(
      new PutCommand({
        TableName: ROOM_CODES_TABLE,
        Item: {
          shortCode,
          roomId,
          createdAt: now,
          expiresAt,
        },
      })
    );

    const participantId = uuidv4();
    const creatorName = 'Room Creator';
    const avatarSeed = createAvatarSeed(creatorName);

    const participant: Participant = {
      id: participantId,
      roomId,
      connectionId: 'REST',
      name: creatorName,
      avatarSeed,
      joinedAt: now,
      lastSeenAt: now,
      isModerator: true,
    };

    await docClient.send(
      new PutCommand({
        TableName: PARTICIPANTS_TABLE,
        Item: {
          ...participant,
          participantId: participant.id,
        },
      })
    );

    const origin = event.headers.origin || event.headers.Origin;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
    };

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        roomId,
        shortCode,
        participantId,
        joinUrl: `https://${process.env.DOMAIN_NAME || 'example.com'}/${shortCode}`,
        expiresAt,
        hasPassword,
      }),
    };
  } catch (error) {
    console.error('Create room error:', error);
    const origin = event.headers.origin || event.headers.Origin;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
    };
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
