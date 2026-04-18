import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Round, Vote, validateRoomCodePath } from '@estimatenest/shared';
import { ZodError } from 'zod';

const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(client);

const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;
const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;

export interface RoundHistoryItem extends Round {
  voteCount: number;
  average?: number;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { code } = event.pathParameters || {};

    // Validate room code format
    const validated = validateRoomCodePath({ code });
    const roomCode = validated.code.toUpperCase();

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

    const { roomId, expiresAt } = codeResult.Item;
    if (new Date(expiresAt) < new Date()) {
      return {
        statusCode: 410,
        body: JSON.stringify({ error: 'Room has expired' }),
      };
    }

    // Fetch revealed rounds for this room, sorted by revealedAt descending (or startedAt)
    const roundsResult = await docClient.send(
      new QueryCommand({
        TableName: ROUNDS_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        FilterExpression: 'isRevealed = :true',
        ExpressionAttributeValues: {
          ':roomId': roomId,
          ':true': true,
        },
        ScanIndexForward: false, // descending order
      })
    );

    const rounds = (roundsResult.Items as Round[]) || [];

    // For each round, fetch votes and compute stats
    const history: RoundHistoryItem[] = [];
    for (const round of rounds) {
      const votesResult = await docClient.send(
        new QueryCommand({
          TableName: VOTES_TABLE,
          KeyConditionExpression: 'roundId = :roundId',
          ExpressionAttributeValues: {
            ':roundId': round.id,
          },
        })
      );
      const votes = (votesResult.Items as Vote[]) || [];
      const numericVotes = votes
        .map((v) => (typeof v.value === 'number' ? v.value : parseFloat(v.value as string)))
        .filter((v) => !isNaN(v));

      let average: number | undefined;
      if (numericVotes.length > 0) {
        average = numericVotes.reduce((sum, val) => sum + val, 0) / numericVotes.length;
      }

      history.push({
        ...round,
        voteCount: votes.length,
        average,
      });
    }

    // CORS headers
    const origin = event.headers.origin || event.headers.Origin;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(history),
    };
  } catch (error) {
    console.error('Round history error:', error);
    // CORS headers for error response
    const origin = event.headers.origin || event.headers.Origin;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
    };

    // Handle validation errors
    if (error instanceof ZodError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Invalid room code format',
          details: error.errors,
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
