import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient } from '../utils/dynamodb';
import { createLogger } from '../utils/logger';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  generateShortCode,
  getRoomTTL,
  Room,
  CardDeck,
  validateCreateRoomRequest,
  parseDeckInput,
} from '@estimatenest/shared';
import { ZodError } from 'zod';
import { hashPassword } from '../utils/password';

const docClient = getDocClient();

const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const logger = createLogger();
  try {
    const rawBody = event.body ? JSON.parse(event.body) : {};
    let validatedBody;
    try {
      validatedBody = validateCreateRoomRequest(rawBody);
    } catch (error) {
      logger.error('Request validation failed', { error });
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
    const now = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + getRoomTTL();

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

    let shortCode = '';
    let codeInserted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      shortCode = generateShortCode();
      try {
        await docClient.send(
          new PutCommand({
            TableName: ROOM_CODES_TABLE,
            Item: {
              shortCode,
              roomId,
              createdAt: now,
              expiresAt,
            },
            ConditionExpression: 'attribute_not_exists(shortCode)',
          })
        );
        codeInserted = true;
        break;
      } catch (error) {
        if ((error as Error).name === 'ConditionalCheckFailedException') {
          if (attempt === 4) {
            throw new Error('Failed to generate unique room code after 5 attempts', {
              cause: error,
            });
          }
          continue;
        }
        throw error;
      }
    }
    if (!codeInserted) {
      throw new Error('Failed to generate unique room code');
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
      moderatorAssigned: false, // first browser join will claim moderator role
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

    // No participant is created here — the first browser user to join
    // via GET /rooms/{code} becomes the first participant and moderator.
    // This avoids phantom participants that never connect via WebSocket.

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
        joinUrl: `https://${process.env.DOMAIN_NAME || 'example.com'}/${shortCode}`,
        expiresAt,
        hasPassword,
      }),
    };
  } catch (error) {
    logger.error('Create room error', { error });
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
