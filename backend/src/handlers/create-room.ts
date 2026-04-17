import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  generateShortCode,
  getRoomTTL,
  Room,
  validateCreateRoomRequest,
} from '@estimatenest/shared';
import { ZodError } from 'zod';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Parse and validate request body
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

      // Re-throw unexpected errors to be caught by outer handler
      throw error;
    }

    const {
      allowAllParticipantsToReveal = false,
      maxParticipants = 50,
      deck = 'fibonacci',
      autoRevealEnabled = true,
      autoRevealCountdownSeconds = 3,
    } = validatedBody;

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
      autoRevealEnabled,
      autoRevealCountdownSeconds,
      deck: typeof deck === 'string' ? deck : deck, // TODO: resolve deck object
    };

    // Write room record
    await docClient.send(
      new PutCommand({
        TableName: ROOMS_TABLE,
        Item: {
          ...room,
          sk: 'META',
        },
      })
    );

    // Write code mapping
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

    // CORS headers
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
      }),
    };
  } catch (error) {
    console.error('Create room error:', error);
    // CORS headers for error response too
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
