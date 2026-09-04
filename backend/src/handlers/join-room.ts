import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient } from '../utils/dynamodb';
import { createLogger } from '../utils/logger';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  createAvatarSeed,
  Participant,
  Round,
  Vote,
  Room,
  validateJoinRoomRequest,
} from '@estimatenest/shared';
import { ZodError } from 'zod';
import { getCacheManager } from '../utils/cache';
import { verifyPassword } from '../utils/password';
import { filterPresent } from '../utils/participants';
import { handleModeratorVacancy } from '../utils/moderator';

const docClient = getDocClient();
const cacheManager = getCacheManager();
const ROOM_CODES_TABLE = process.env.ROOM_CODES_TABLE!;
const ROOMS_TABLE = process.env.ROOMS_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;
const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;
const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60;

// Every response — including error paths — needs CORS headers, otherwise the
// browser blocks them and the client sees a network error instead of the
// status code (e.g. the 403 PASSWORD_REQUIRED that opens the join dialog).
function corsHeaders(event: APIGatewayProxyEvent): Record<string, string> {
  const origin = event.headers.origin || event.headers.Origin;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
  };
}

// Helper function to create participant record
async function createParticipantRecord(
  roomId: string,
  participantId: string,
  name: string,
  avatarSeed: string,
  isModerator: boolean = false,
  expiresAt?: number
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
        expiresAt,
      },
    })
  );
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const logger = createLogger();
  try {
    // Validate request parameters
    const requestData = {
      code: event.pathParameters?.code,
      participantId: event.queryStringParameters?.participantId,
      name: event.queryStringParameters?.name,
      moderatorPassword: event.queryStringParameters?.moderatorPassword,
    };

    let validatedData;
    try {
      validatedData = validateJoinRoomRequest(requestData);
    } catch (error) {
      logger.error('Request validation failed', { error });

      if (error instanceof ZodError || (error as Error).name === 'ZodError') {
        const zodError = error as { errors?: Array<{ path: string[]; message: string }> };
        const details = zodError.errors
          ? zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
          : ['Validation failed'];
        return {
          statusCode: 400,
          headers: corsHeaders(event),
          body: JSON.stringify({
            error: 'Invalid request parameters',
            details,
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
        headers: corsHeaders(event),
        body: JSON.stringify({ error: 'Room not found' }),
      };
    }

    const { roomId, expiresAt: rawExpiresAt } = codeResult.Item;
    const expiresAtMs =
      typeof rawExpiresAt === 'number' ? rawExpiresAt * 1000 : new Date(rawExpiresAt).getTime();
    if (expiresAtMs < Date.now()) {
      return {
        statusCode: 410,
        headers: corsHeaders(event),
        body: JSON.stringify({ error: 'Room has expired' }),
      };
    }

    // Fetch room details
    const roomResult = await docClient.send(
      new GetCommand({
        TableName: ROOMS_TABLE,
        Key: { id: roomId, sk: 'META' },
      })
    );
    if (!roomResult.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders(event),
        body: JSON.stringify({ error: 'Room not found' }),
      };
    }
    const room = roomResult.Item as Room;

    // Participant rows must expire with the room (TTL in epoch seconds) —
    // without expiresAt a row whose client never returns lives forever.
    const participantExpiresAt =
      typeof room.expiresAt === 'number'
        ? room.expiresAt
        : Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;

    // Check password if room has one
    let passwordValid = !room.moderatorPassword;
    if (room.moderatorPassword && validatedData.participantId) {
      const pwParticipantResult = await docClient.send(
        new GetCommand({
          TableName: PARTICIPANTS_TABLE,
          Key: { roomId, participantId: validatedData.participantId },
        })
      );
      passwordValid = !!pwParticipantResult.Item;
    }
    if (!passwordValid) {
      if (!validatedData.moderatorPassword) {
        return {
          statusCode: 403,
          headers: corsHeaders(event),
          body: JSON.stringify({
            error: 'Password required to join this room',
            code: 'PASSWORD_REQUIRED',
          }),
        };
      }
      if (!verifyPassword(validatedData.moderatorPassword, room.moderatorPassword!)) {
        return {
          statusCode: 403,
          headers: corsHeaders(event),
          body: JSON.stringify({ error: 'Incorrect password', code: 'INCORRECT_PASSWORD' }),
        };
      }
      // Verified: a fresh joiner with the correct password is past the gate
      // and may participate in the moderator claim below.
      passwordValid = true;
    }

    // Determine participant ID (provided for polling, or new)
    const providedParticipantId = validatedData.participantId;
    const providedName = validatedData.name || 'Anonymous';
    let participantId: string;
    let name: string;
    let avatarSeed: string;
    let isNewParticipant = false;
    let isModerator = false;

    // Fetch participant via GetCommand if ID provided (optimization)
    let fetchedParticipant: Participant | null = null;
    if (providedParticipantId) {
      try {
        const participantResult = await docClient.send(
          new GetCommand({
            TableName: PARTICIPANTS_TABLE,
            Key: { roomId, participantId: providedParticipantId },
          })
        );
        if (participantResult.Item) {
          fetchedParticipant = participantResult.Item as Participant;
        }
      } catch (error) {
        // If Get fails (e.g., item not found), treat as missing
        logger.debug('Participant not found via GetCommand', { error });
      }
    }

    // Fetch all participants in the room (for moderator determination and response) - cached
    const existingParticipants = await cacheManager.getParticipantsWithCache(roomId);

    // Start with existing participants as our base list
    const participants = [...existingParticipants];

    if (providedParticipantId && fetchedParticipant) {
      // Participant exists - use stored details from GetCommand
      participantId = providedParticipantId;
      isModerator = fetchedParticipant.isModerator || false;
      // Use provided name if supplied, otherwise keep stored name
      const newName = validatedData.name?.trim();
      const nameChanged = newName && newName !== fetchedParticipant.name;
      name = nameChanged ? newName : fetchedParticipant.name;
      avatarSeed = nameChanged ? createAvatarSeed(name) : fetchedParticipant.avatarSeed;
      // Update lastSeenAt and possibly name in DynamoDB. A row whose
      // connectionId was removed (client left) becomes an active REST poller
      // again: mark it REST so the present-filter keeps listing it — but never
      // overwrite a live WebSocket mapping.
      const now = new Date().toISOString();
      const updateExpression = nameChanged
        ? 'SET lastSeenAt = :now, #nm = :name, avatarSeed = :seed, expiresAt = :exp, connectionId = if_not_exists(connectionId, :rest)'
        : 'SET lastSeenAt = :now, expiresAt = :exp, connectionId = if_not_exists(connectionId, :rest)';
      await docClient.send(
        new UpdateCommand({
          TableName: PARTICIPANTS_TABLE,
          Key: { roomId, participantId: providedParticipantId },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: nameChanged ? { '#nm': 'name' } : undefined,
          ExpressionAttributeValues: nameChanged
            ? {
                ':now': now,
                ':name': name,
                ':seed': avatarSeed,
                ':exp': participantExpiresAt,
                ':rest': 'REST',
              }
            : { ':now': now, ':exp': participantExpiresAt, ':rest': 'REST' },
        })
      );
      cacheManager.invalidateParticipants(roomId);
      // Update participant in our local list if present
      const participantIndex = participants.findIndex((p) => p.id === participantId);
      if (participantIndex >= 0) {
        participants[participantIndex] = {
          ...participants[participantIndex],
          name,
          avatarSeed,
          lastSeenAt: now,
          connectionId: participants[participantIndex].connectionId ?? 'REST',
        };
      } else {
        // Participant not in cached list (should not happen) - add it
        participants.push({
          ...fetchedParticipant,
          name,
          avatarSeed,
          lastSeenAt: now,
          connectionId: fetchedParticipant.connectionId ?? 'REST',
        });
      }
    } else if (providedParticipantId) {
      // Participant ID provided but not found - treat as new participant
      isNewParticipant = true;
      participantId = uuidv4();
      name = providedName;
      avatarSeed = createAvatarSeed(name);
      isModerator = false;
      // Anyone past the password gate may claim; CAS on moderatorAssigned keeps it one-time per room.
      if (passwordValid) {
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: ROOMS_TABLE,
              Key: { id: roomId, sk: 'META' },
              UpdateExpression: 'SET moderatorAssigned = :true',
              ConditionExpression:
                'attribute_not_exists(moderatorAssigned) OR moderatorAssigned = :false',
              ExpressionAttributeValues: {
                ':true': true,
                ':false': false,
              },
            })
          );
          isModerator = true;
        } catch (error) {
          if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
        }
      }
      await createParticipantRecord(
        roomId,
        participantId,
        name,
        avatarSeed,
        isModerator,
        participantExpiresAt
      );
      // Invalidate participant cache since new participant added
      cacheManager.invalidateParticipants(roomId);
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
    } else {
      // New participant joining without ID
      isNewParticipant = true;
      participantId = uuidv4();
      name = providedName;
      avatarSeed = createAvatarSeed(name);
      isModerator = false;
      // Anyone past the password gate may claim; CAS on moderatorAssigned keeps it one-time per room.
      if (passwordValid) {
        try {
          await docClient.send(
            new UpdateCommand({
              TableName: ROOMS_TABLE,
              Key: { id: roomId, sk: 'META' },
              UpdateExpression: 'SET moderatorAssigned = :true',
              ConditionExpression:
                'attribute_not_exists(moderatorAssigned) OR moderatorAssigned = :false',
              ExpressionAttributeValues: {
                ':true': true,
                ':false': false,
              },
            })
          );
          isModerator = true;
        } catch (error) {
          if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
        }
      }
      await createParticipantRecord(
        roomId,
        participantId,
        name,
        avatarSeed,
        isModerator,
        participantExpiresAt
      );
      // Invalidate participant cache since new participant added
      cacheManager.invalidateParticipants(roomId);
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

    // A moderator handoff pending from a disconnect may now resolve (the
    // joining participant could be the returning moderator or a new holder).
    // Lazy and self-healing — never block the join on it.
    try {
      const vacancy = await handleModeratorVacancy(roomId, participantId);
      if (vacancy.handled) {
        logger.info('Moderator vacancy resolved via join', { roomId, reason: vacancy.reason });
      }
    } catch (error) {
      logger.warn('Moderator vacancy resolution failed', { roomId, error });
    }

    // Fetch latest round (active or most recent revealed)
    let round: Round | null = null;
    let votes: Vote[] = [];

    // First, try to get the active round via the ACTIVE coordination item (consistent read)
    let roundItem = null;
    const activeCoordResult = await docClient.send(
      new GetCommand({
        TableName: ROUNDS_TABLE,
        Key: { roomId, roundId: 'ACTIVE' },
        ConsistentRead: true,
      })
    );
    if (activeCoordResult.Item && activeCoordResult.Item.activeRoundId) {
      const activeRoundId = activeCoordResult.Item.activeRoundId;
      const roundResult = await docClient.send(
        new GetCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId: activeRoundId },
        })
      );
      if (roundResult.Item && !roundResult.Item.isRevealed) {
        roundItem = roundResult.Item;
      }
    }

    // If no active round found via coordination item, fall back to GSI query
    if (!roundItem) {
      // Query for active round (not revealed) using GSI sorted by startedAt descending
      const activeRoundsResult = await docClient.send(
        new QueryCommand({
          TableName: ROUNDS_TABLE,
          IndexName: 'RoomIdStartedAtIndex',
          KeyConditionExpression: 'roomId = :roomId',
          FilterExpression: 'isRevealed = :false',
          ExpressionAttributeValues: {
            ':roomId': roomId,
            ':false': false,
          },
          ScanIndexForward: false, // descending (most recent first)
          Limit: 1,
        })
      );

      if (activeRoundsResult.Items && activeRoundsResult.Items.length > 0) {
        roundItem = activeRoundsResult.Items[0];
      } else {
        // No active round, get most recent round (any status)
        const latestRoundsResult = await docClient.send(
          new QueryCommand({
            TableName: ROUNDS_TABLE,
            IndexName: 'RoomIdStartedAtIndex',
            KeyConditionExpression: 'roomId = :roomId',
            ExpressionAttributeValues: {
              ':roomId': roomId,
            },
            ScanIndexForward: false, // descending (most recent first)
            Limit: 1,
          })
        );
        if (latestRoundsResult.Items && latestRoundsResult.Items.length > 0) {
          roundItem = latestRoundsResult.Items[0];
        }
      }
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
        scheduledRevealAt: roundItem.scheduledRevealAt || undefined,
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

    // Only present participants are shown: rows whose WebSocket is gone AND
    // whose REST polling stopped (ghosts) must not appear. The joiner's own
    // row was just refreshed above and always qualifies.
    const presentParticipants = filterPresent(participants);

    // Remove connectionId from response for privacy/security
    const participantsWithoutConnection = presentParticipants.map((p) => ({
      id: p.id,
      roomId: p.roomId,
      name: p.name,
      avatarSeed: p.avatarSeed,
      joinedAt: p.joinedAt,
      lastSeenAt: p.lastSeenAt,
      isModerator: p.isModerator,
    }));

    return {
      statusCode: 200,
      headers: corsHeaders(event),
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
        room: {
          deck: room.deck,
          allowAllParticipantsToReveal: room.allowAllParticipantsToReveal,
          autoRevealEnabled: room.autoRevealEnabled,
          autoRevealCountdownSeconds: room.autoRevealCountdownSeconds,
          maxParticipants: room.maxParticipants,
        },
      }),
    };
  } catch (error) {
    logger.error('Join room error', { error });
    const headers = corsHeaders(event);

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

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
