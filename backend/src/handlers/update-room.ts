import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Room, validateUpdateRoomRequest, validateRoomCodePath } from '@estimatenest/shared';
import { ZodError } from 'zod';

const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(client);

const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { code } = event.pathParameters || {};

    // Validate room code format
    const validatedCode = validateRoomCodePath({ code });
    const roomCode = validatedCode.code.toUpperCase();

    // Parse and validate request body
    const rawBody = event.body ? JSON.parse(event.body) : {};
    let validatedBody;
    try {
      validatedBody = validateUpdateRoomRequest(rawBody);
    } catch (error) {
      console.error('Request validation failed:', error);
      const origin = event.headers.origin || event.headers.Origin;
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin || '*',
      };

      if (error instanceof ZodError || (error as Error).name === 'ZodError') {
        const zodError = error as {
          issues?: Array<{ path: string[]; message: string }>;
          errors?: Array<{ path: string[]; message: string }>;
        };
        const issues = zodError.issues || zodError.errors;
        const details = issues
          ? issues.map((e) => `${e.path.join('.')}: ${e.message}`)
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
      autoRevealEnabled,
      autoRevealCountdownSeconds,
      allowAllParticipantsToReveal,
      maxParticipants,
    } = validatedBody;

    // Look up room by short code
    const codeResult = await docClient.send(
      new GetCommand({
        TableName: ROOM_CODES_TABLE,
        Key: { shortCode: roomCode },
      })
    );

    if (!codeResult.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Room not found' }),
      };
    }

    const { roomId } = codeResult.Item;

    // Verify participant is moderator
    const { connectionId } = event.requestContext;
    const participantResult = await docClient.send(
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

    const participant = participantResult.Items?.[0];
    if (!participant || !participant.isModerator) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Only moderators can update room settings' }),
      };
    }

    // Build update expression dynamically based on provided fields
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};

    if (autoRevealEnabled !== undefined) {
      updateExpressions.push('#autoRevealEnabled = :autoRevealEnabled');
      expressionAttributeNames['#autoRevealEnabled'] = 'autoRevealEnabled';
      expressionAttributeValues[':autoRevealEnabled'] = autoRevealEnabled;
    }

    if (autoRevealCountdownSeconds !== undefined) {
      updateExpressions.push('#autoRevealCountdownSeconds = :autoRevealCountdownSeconds');
      expressionAttributeNames['#autoRevealCountdownSeconds'] = 'autoRevealCountdownSeconds';
      expressionAttributeValues[':autoRevealCountdownSeconds'] = autoRevealCountdownSeconds;
    }

    if (allowAllParticipantsToReveal !== undefined) {
      updateExpressions.push('#allowAllParticipantsToReveal = :allowAllParticipantsToReveal');
      expressionAttributeNames['#allowAllParticipantsToReveal'] = 'allowAllParticipantsToReveal';
      expressionAttributeValues[':allowAllParticipantsToReveal'] = allowAllParticipantsToReveal;
    }

    if (maxParticipants !== undefined) {
      updateExpressions.push('#maxParticipants = :maxParticipants');
      expressionAttributeNames['#maxParticipants'] = 'maxParticipants';
      expressionAttributeValues[':maxParticipants'] = maxParticipants;
    }
    if (updateExpressions.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No valid fields to update' }),
      };
    }

    // Update room in DynamoDB
    await docClient.send(
      new UpdateCommand({
        TableName: ROOMS_TABLE,
        Key: { id: roomId, sk: 'META' },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    // Fetch updated room
    const updatedRoomResult = await docClient.send(
      new GetCommand({
        TableName: ROOMS_TABLE,
        Key: { id: roomId, sk: 'META' },
      })
    );
    const updatedRoom = updatedRoomResult.Item as Room;

    // CORS headers
    const origin = event.headers.origin || event.headers.Origin;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        room: {
          id: updatedRoom.id,
          shortCode: updatedRoom.shortCode,
          autoRevealEnabled: updatedRoom.autoRevealEnabled,
          autoRevealCountdownSeconds: updatedRoom.autoRevealCountdownSeconds,
        },
      }),
    };
  } catch (error) {
    console.error('Update room error:', error);
    const origin = event.headers.origin || event.headers.Origin;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
    };

    if (error instanceof ZodError || (error as Error).name === 'ZodError') {
      const zodError = error as {
        issues?: Array<{ path: string[]; message: string }>;
        errors?: Array<{ path: string[]; message: string }>;
      };
      const issues = zodError.issues || zodError.errors;
      const details = issues
        ? issues.map((e) => `${e.path.join('.')}: ${e.message}`)
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

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
