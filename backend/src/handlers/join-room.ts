import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  createAvatarSeed,
  Participant,
  Round,
  Vote,
  validateJoinRoomRequest,
} from '@estimatenest/shared';
import { ZodError } from 'zod';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;
const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;

// Helper function to create participant record
async function createParticipantRecord(
  roomId: string,
  participantId: string,
  name: string,
  avatarSeed: string,
  isModerator: boolean = false
) {
  const participant: Participant = {
    id: participantId,
    roomId,
    connectionId: 'REST',
    name,
    avatarSeed,
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    isModerator,
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
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Validate request parameters
    const requestData = {
      code: event.pathParameters?.code,
      participantId: event.queryStringParameters?.participantId,
      name: event.queryStringParameters?.name,
    };

    let validatedData;
    try {
      validatedData = validateJoinRoomRequest(requestData);
    } catch (error) {
      console.error('Request validation failed:', error);

      if (error instanceof ZodError) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Invalid request parameters',
            details: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
          }),
        };
      }

      // Re-throw unexpected errors to be caught by outer handler
      throw error;
    }

    const { code } = validatedData;

    // Look up room by short code
    const codeResult = await docClient.send(
      new GetCommand({
        TableName: ROOM_CODES_TABLE,
        Key: { shortCode: code.toUpperCase() },
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

    // Fetch all participants in the room (for moderator determination)
    const participantsResult = await docClient.send(
      new QueryCommand({
        TableName: PARTICIPANTS_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        ExpressionAttributeValues: {
          ':roomId': roomId,
        },
      })
    );
    const existingParticipants = (participantsResult.Items as Participant[]) || [];

    // Determine participant ID (provided for polling, or new)
    const providedParticipantId = validatedData.participantId;
    const providedName = validatedData.name || 'Anonymous';
    let participantId: string;
    let name: string;
    let avatarSeed: string;
    let isNewParticipant = false;
    let isModerator = false;

    // Start with existing participants as our base list
    const participants = [...existingParticipants];

    if (providedParticipantId) {
      // Try to find existing participant in the already fetched list
      const existingParticipant = existingParticipants.find((p) => p.id === providedParticipantId);
      if (existingParticipant) {
        // Participant exists - use stored details
        participantId = providedParticipantId;
        name = existingParticipant.name;
        avatarSeed = existingParticipant.avatarSeed;
        isModerator = existingParticipant.isModerator || false;
        // Update lastSeenAt in DynamoDB
        await docClient.send(
          new UpdateCommand({
            TableName: PARTICIPANTS_TABLE,
            Key: { roomId, participantId: providedParticipantId },
            UpdateExpression: 'SET lastSeenAt = :now',
            ExpressionAttributeValues: {
              ':now': new Date().toISOString(),
            },
          })
        );
        // Update participant in our local list
        const participantIndex = participants.findIndex((p) => p.id === participantId);
        if (participantIndex >= 0) {
          participants[participantIndex] = {
            ...participants[participantIndex],
            lastSeenAt: new Date().toISOString(),
          };
        }
      } else {
        // Participant not found - treat as new participant
        isNewParticipant = true;
        participantId = uuidv4();
        name = providedName;
        avatarSeed = createAvatarSeed(name);
        isModerator = existingParticipants.length === 0;
        await createParticipantRecord(roomId, participantId, name, avatarSeed, isModerator);
        // Add new participant to our list
        participants.push({
          id: participantId,
          roomId,
          connectionId: 'REST',
          name,
          avatarSeed,
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          isModerator,
        });
      }
    } else {
      // New participant joining
      isNewParticipant = true;
      participantId = uuidv4();
      name = providedName;
      avatarSeed = createAvatarSeed(name);
      isModerator = existingParticipants.length === 0;
      await createParticipantRecord(roomId, participantId, name, avatarSeed, isModerator);
      // Add new participant to our list
      participants.push({
        id: participantId,
        roomId,
        connectionId: 'REST',
        name,
        avatarSeed,
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        isModerator,
      });
    }

    // Fetch latest round (active or most recent revealed)
    let round: Round | null = null;
    let votes: Vote[] = [];

    // Get all rounds for the room (typically < 10 rounds per room)
    const allRoundsResult = await docClient.send(
      new QueryCommand({
        TableName: ROUNDS_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        ExpressionAttributeValues: {
          ':roomId': roomId,
        },
      })
    );

    const allRounds = allRoundsResult.Items || [];

    // Find active round (not revealed)
    let roundItem = allRounds.find((item) => !item.isRevealed);

    // If no active round, get the most recent round (by startedAt)
    if (!roundItem && allRounds.length > 0) {
      roundItem = allRounds.reduce((latest, current) => {
        const latestDate = new Date(latest.startedAt || 0).getTime();
        const currentDate = new Date(current.startedAt || 0).getTime();
        return currentDate > latestDate ? current : latest;
      });
    }

    if (roundItem) {
      // Map DynamoDB attributes to Round interface
      round = {
        id: roundItem.roundId || roundItem.id,
        roomId: roundItem.roomId,
        title: roundItem.title,
        description: roundItem.description,
        startedAt: roundItem.startedAt,
        revealedAt: roundItem.revealedAt,
        isRevealed: roundItem.isRevealed,
      };
      const votesResult = await docClient.send(
        new QueryCommand({
          TableName: VOTES_TABLE,
          KeyConditionExpression: 'roundId = :roundId',
          ExpressionAttributeValues: {
            ':roundId': round.id,
          },
        })
      );
      votes = (votesResult.Items as Vote[]) || [];
    }

    // Remove connectionId from response for privacy/security
    const participantsWithoutConnection = participants.map((p) => ({
      id: p.id,
      roomId: p.roomId,
      name: p.name,
      avatarSeed: p.avatarSeed,
      joinedAt: p.joinedAt,
      lastSeenAt: p.lastSeenAt,
      isModerator: p.isModerator,
    }));

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
        roomId,
        participantId,
        name,
        avatarSeed,
        isNewParticipant,
        webSocketUrl: process.env.WEBSOCKET_URL || 'wss://example.com',
        participants: participantsWithoutConnection,
        round,
        votes,
      }),
    };
  } catch (error) {
    console.error('Join room error:', error);
    // CORS headers for error response
    const origin = event.headers.origin || event.headers.Origin;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
    };

    if (error instanceof ZodError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Invalid request parameters',
          details: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
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
