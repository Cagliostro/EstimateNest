// Vote handler for WebSocket messages
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDocClient } from '../utils/dynamodb';
import { createLogger } from '../utils/logger';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import {
  Vote,
  Round,
  WebSocketMessage,
  Participant,
  createAvatarSeed,
  Room,
  safeParseWebSocketMessage,
} from '@estimatenest/shared';
import { broadcastToRoom, sendToConnection } from '../utils/broadcast';
import { getCacheManager } from '../utils/cache';

// Helper to create properly typed WebSocket responses
function createResponse(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, payload });
}

function createErrorResponse(message: string, code?: string): string {
  return createResponse('error', { message, code });
}

function createSuccessResponse(message: string): string {
  return createResponse('ack', { message });
}

/**
 * Check and increment rate limit for a connection and message type
 * Returns true if allowed, false if rate limited
 */
async function checkRateLimit(
  connectionId: string,
  messageType: string,
  limit: number = 20,
  windowSeconds: number = 1
): Promise<boolean> {
  const key = `${connectionId}:${messageType}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  // Count messages in current window
  const countResult = await docClient.send(
    new QueryCommand({
      TableName: RATE_LIMIT_TABLE,
      KeyConditionExpression: '#key = :key AND #timestamp >= :windowStart',
      ExpressionAttributeNames: {
        '#key': 'key',
        '#timestamp': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':key': key,
        ':windowStart': windowStart,
      },
      Select: 'COUNT',
    })
  );

  if (countResult.Count >= limit) {
    return false;
  }

  // Record this message
  await docClient.send(
    new PutCommand({
      TableName: RATE_LIMIT_TABLE,
      Item: {
        key,
        timestamp: now,
        expiresAt: Math.floor(now / 1000) + windowSeconds + 60, // TTL: window + 60 seconds buffer
      },
    })
  );

  return true;
}

const docClient = getDocClient();

const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;
const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;
// Cache manager for reducing DynamoDB reads
const cacheManager = getCacheManager();

// Backward compatibility wrapper for existing room cache calls
async function getRoomWithCache(roomId: string): Promise<Record<string, unknown> | undefined> {
  return cacheManager.getRoomWithCache(roomId);
}

/**
 * Get or create an active round for a room atomically.
 * Uses an 'ACTIVE' item in ROUNDS_TABLE to coordinate round creation.
 */
async function getOrCreateActiveRound(
  roomId: string,
  retryCount = 0
): Promise<{ roundId: string; round: Round }> {
  const logger = createLogger();
  const MAX_RETRIES = 3;
  logger.info('getOrCreateActiveRound called', { roomId, retry: retryCount });
  // Try cache first
  const cachedRound = await cacheManager.getActiveRoundWithCache(roomId);
  if (cachedRound) {
    logger.info('Found cached round', { roundId: cachedRound.id });
    return { roundId: cachedRound.id, round: cachedRound };
  }
  logger.info('No cached round, creating new one');

  const newRoundId = uuidv4();
  const now = new Date().toISOString();
  const newRound: Round = {
    id: newRoundId,
    roomId,
    startedAt: now,
    isRevealed: false,
    scheduledRevealAt: undefined,
  };

  // Attempt to claim the active round slot
  try {
    await docClient.send(
      new PutCommand({
        TableName: ROUNDS_TABLE,
        Item: {
          roomId,
          roundId: 'ACTIVE',
          activeRoundId: newRoundId,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(roundId) OR #activeRoundId = :null',
        ExpressionAttributeNames: {
          '#activeRoundId': 'activeRoundId',
        },
        ExpressionAttributeValues: {
          ':null': null,
        },
      })
    );

    // Successfully claimed active round, create the round item
    await docClient.send(
      new PutCommand({
        TableName: ROUNDS_TABLE,
        Item: {
          ...newRound,
          roundId: newRoundId,
        },
      })
    );

    // Invalidate cache
    cacheManager.invalidateActiveRound(roomId);
    logger.info('Successfully created new round', { roomId, roundId: newRoundId });
    return { roundId: newRoundId, round: newRound };
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') {
      // Someone else claimed the active round, fetch it
      const activeItemResult = await docClient.send(
        new GetCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId: 'ACTIVE' },
          ConsistentRead: true,
        })
      );

      const activeItem = activeItemResult.Item;
      if (!activeItem || !activeItem.activeRoundId) {
        // Should not happen, retry with increment
        logger.warn('Active item missing activeRoundId, retrying', { roomId });
        if (retryCount >= MAX_RETRIES) {
          throw new Error(
            `Max retries (${MAX_RETRIES}) exceeded while trying to create active round`
          );
        }
        return getOrCreateActiveRound(roomId, retryCount + 1);
      }

      const existingRoundId = activeItem.activeRoundId;
      const roundResult = await docClient.send(
        new GetCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId: existingRoundId },
        })
      );

      const item = roundResult.Item;
      if (!item) {
        // Round item missing, clean up broken active item and retry
        logger.error('Round item missing for activeRoundId, cleaning up', {
          roomId,
          existingRoundId,
        });
        await docClient.send(
          new DeleteCommand({
            TableName: ROUNDS_TABLE,
            Key: { roomId, roundId: 'ACTIVE' },
          })
        );
        if (retryCount >= MAX_RETRIES) {
          throw new Error(`Max retries (${MAX_RETRIES}) exceeded while cleaning up missing round`);
        }
        return getOrCreateActiveRound(roomId, retryCount + 1);
      }

      // Map DynamoDB attributes to Round interface
      const round: Round = {
        id: item.roundId || item.id,
        roomId: item.roomId,
        title: item.title,
        description: item.description,
        startedAt: item.startedAt,
        revealedAt: item.revealedAt,
        isRevealed: item.isRevealed,
        scheduledRevealAt: item.scheduledRevealAt || undefined,
      };

      logger.info('Found existing round created by another participant', {
        roundId: existingRoundId,
      });
      return { roundId: existingRoundId, round };
    }
    throw error;
  }
}

async function handleVote(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'vote' }
) {
  const logger = createLogger();
  logger.info('Vote handler start');
  const { connectionId } = event.requestContext;
  const { roundId: requestedRoundId = '', value } = message.payload;

  if (value === undefined) {
    throw new Error('Missing vote value');
  }

  // Find participant by connectionId
  const queryResult = await docClient.send(
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

  const participant = queryResult.Items?.[0];
  if (!participant) {
    throw new Error('Participant not found');
  }
  logger.info('Found participant', {
    roomId: participant.roomId,
    isModerator: participant.isModerator,
  });

  const { roomId, participantId } = participant;

  // Validate vote value against room's deck
  const roomRecord = await getRoomWithCache(roomId);
  if (!roomRecord) {
    throw new Error('Room not found');
  }
  const room = roomRecord as Room;
  if (!room.deck.values.includes(value)) {
    throw new Error(`Invalid vote value. Allowed values: ${room.deck.values.join(', ')}`);
  }

  // Determine active round
  let roundId = requestedRoundId;
  let round: Round;
  if (roundId) {
    // Get the specified round
    const roundResult = await docClient.send(
      new GetCommand({
        TableName: ROUNDS_TABLE,
        Key: { roomId, roundId },
      })
    );
    const item = roundResult.Item;
    if (!item) {
      throw new Error('Round not found');
    }
    // Map DynamoDB attributes to Round interface
    round = {
      id: item.roundId || item.id,
      roomId: item.roomId,
      title: item.title,
      description: item.description,
      startedAt: item.startedAt,
      revealedAt: item.revealedAt,
      isRevealed: item.isRevealed,
      scheduledRevealAt: item.scheduledRevealAt || undefined,
    };
    if (round.isRevealed) {
      throw new Error('Round is already revealed');
    }
  } else {
    logger.info('No roundId provided, finding or creating active round');
    const activeRoundResult = await getOrCreateActiveRound(roomId);
    round = activeRoundResult.round;
    roundId = activeRoundResult.roundId;
  }

  // Ensure roundId is defined
  if (!roundId) {
    throw new Error('roundId is undefined');
  }
  // Ensure round is defined
  if (!round) {
    throw new Error('round is undefined after getOrCreateActiveRound');
  }
  // Create vote
  const voteId = uuidv4();
  const votedAt = new Date().toISOString();
  const idempotencyKey = createHash('sha256')
    .update(`${participantId}:${roundId}:${JSON.stringify(value)}`)
    .digest('hex');
  const vote: Vote = {
    id: voteId,
    roundId,
    participantId,
    value,
    votedAt,
  };

  // Store vote and update round in transaction
  logger.debug('Attempting vote transaction', { roomId, roundId });
  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: VOTES_TABLE,
              Item: {
                ...vote,
                roomId,
                idempotencyKey,
              },
              ConditionExpression: 'attribute_not_exists(idempotencyKey) OR idempotencyKey <> :key',
              ExpressionAttributeValues: {
                ':key': idempotencyKey,
              },
            },
          },
          {
            Update: {
              TableName: ROUNDS_TABLE,
              Key: { roomId, roundId },
              UpdateExpression: 'SET #updated = :now',
              ExpressionAttributeNames: {
                '#updated': 'updatedAt',
              },
              ExpressionAttributeValues: {
                ':now': votedAt,
              },
            },
          },
        ],
      })
    );
    logger.info('Vote transaction successful', { roundId });
  } catch (transactionError) {
    logger.error('Vote transaction failed', { error: transactionError, roundId });
    throw transactionError; // Re-throw to trigger error response
  }

  // Invalidate caches to ensure fresh data for auto-reveal check
  cacheManager.invalidateParticipants(roomId);
  cacheManager.invalidateActiveRound(roomId);
  // Fetch participants first to know how many active participants exist (cached)
  const participants = await cacheManager.getParticipantsWithCache(roomId);
  const activeParticipants = participants.filter(
    (p) => p.connectionId && p.connectionId !== 'REST'
  );

  logger.info('Participant details', {
    total: participants.length,
    active: activeParticipants.length,
    moderators: participants.filter((p) => p.isModerator).length,
  });

  // Fetch all votes for this round to broadcast, with aggressive retry for consistency
  let votes: Vote[] = [];
  const expectedVoteCount = activeParticipants.length;
  logger.debug('Expected vote count', { expectedVoteCount, roundId });

  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 100;
  const MAX_DELAY_MS = 1000;
  const totalQueryStart = Date.now();
  let attemptsUsed = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    attemptsUsed++;
    const queryStart = Date.now();
    const votesResult = await docClient.send(
      new QueryCommand({
        TableName: VOTES_TABLE,
        KeyConditionExpression: 'roundId = :roundId',
        ExpressionAttributeValues: {
          ':roundId': roundId,
        },
        ConsistentRead: true,
      })
    );
    const queryDuration = Date.now() - queryStart;
    votes = (votesResult.Items as Vote[]) || [];
    logger.debug('Votes query attempt', {
      attempt: attempt + 1,
      count: votes.length,
      queryDuration,
    });

    // Log which votes we found vs expected participants
    const foundParticipantIds = votes.map((v) => v.participantId);
    const missingParticipantIds = activeParticipants
      .filter((p) => !foundParticipantIds.includes(p.id))
      .map((p) => p.id);

    if (missingParticipantIds.length > 0) {
      logger.debug('Missing votes for participants', {
        missingCount: missingParticipantIds.length,
      });
    }

    // If we have all expected votes, break immediately
    if (votes.length >= expectedVoteCount && expectedVoteCount > 0) {
      logger.debug('Found all expected votes', { count: expectedVoteCount });
      break;
    }

    // If no active participants (shouldn't happen), break
    if (expectedVoteCount === 0) {
      logger.debug('No active participants, no votes expected');
      break;
    }

    // Wait before retrying (exponential backoff with cap)
    const delayMs = Math.min(BASE_DELAY_MS * Math.pow(1.5, attempt), MAX_DELAY_MS);
    logger.debug('Waiting before retry', { delayMs, attempt: attempt + 1 });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const totalQueryDuration = Date.now() - totalQueryStart;
  logger.debug('Total votes query', { totalQueryDuration, attemptsUsed });

  // Check if we're still missing votes after all retries
  const foundParticipantIds = votes.map((v) => v.participantId);
  const missingParticipantIdsAfterRetry = activeParticipants
    .filter((p) => !foundParticipantIds.includes(p.id))
    .map((p) => p.id);

  // If still missing votes after all retries, try one more time with longer delay
  if (missingParticipantIdsAfterRetry.length > 0 && votes.length < expectedVoteCount) {
    logger.warn('Missing votes after retries, waiting for final attempt', {
      missingCount: missingParticipantIdsAfterRetry.length,
      expectedVoteCount,
      roundId,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Final attempt
    const finalVotesResult = await docClient.send(
      new QueryCommand({
        TableName: VOTES_TABLE,
        KeyConditionExpression: 'roundId = :roundId',
        ExpressionAttributeValues: {
          ':roundId': roundId,
        },
        ConsistentRead: true,
      })
    );
    votes = (finalVotesResult.Items as Vote[]) || [];
    logger.info('Final votes query after wait', { count: votes.length });

    const finalFoundParticipantIds = votes.map((v) => v.participantId);
    const finalMissingParticipantIds = activeParticipants
      .filter((p) => !finalFoundParticipantIds.includes(p.id))
      .map((p) => p.id);

    if (finalMissingParticipantIds.length > 0) {
      logger.error('CRITICAL: Still missing votes after final wait', {
        missingCount: finalMissingParticipantIds.length,
        expectedVoteCount,
        roundId,
      });
    } else {
      logger.info('Successfully retrieved all votes after final wait', {
        count: expectedVoteCount,
      });
    }
  } else if (votes.length === expectedVoteCount) {
    logger.info('Successfully retrieved all votes', { count: expectedVoteCount, roundId });
  }

  const allVoted = votes.length === activeParticipants.length && activeParticipants.length > 0;
  logger.info('All voted check', {
    votesCount: votes.length,
    participantsCount: participants.length,
    activeParticipantsCount: activeParticipants.length,
    allVoted,
    roundIsRevealed: round.isRevealed,
  });
  // Detailed debug
  const missingVoterIds = activeParticipants
    .filter((p) => !votes.find((v) => v.participantId === p.id))
    .map((p) => p.id);
  if (missingVoterIds.length > 0) {
    logger.debug('Missing voters', { count: missingVoterIds.length });
  }

  // Fetch room to check auto-reveal settings (cached)
  const roomSettings = (await getRoomWithCache(roomId)) as Room | undefined;
  const autoRevealEnabled = roomSettings?.autoRevealEnabled !== false; // default: true
  const countdownSeconds = roomSettings?.autoRevealCountdownSeconds ?? 3; // default: 3

  // If everyone voted, auto-reveal is enabled, and round not yet revealed
  if (allVoted && autoRevealEnabled && !round.isRevealed) {
    logger.info('All participants voted, checking auto-reveal', {
      roomId,
      roundId,
      countdownSeconds,
    });

    // Only schedule auto-reveal if not already scheduled (prevents duplicate countdowns)
    if (!round.scheduledRevealAt) {
      logger.info('Scheduling auto-reveal', { roomId, roundId, countdownSeconds });

      // Broadcast countdown start to all participants
      await broadcastToRoom(event, roomId, {
        type: 'autoRevealCountdown',
        payload: { countdownSeconds },
      });

      // Schedule the reveal by updating the round with scheduledRevealAt
      const scheduledRevealAt = new Date(Date.now() + countdownSeconds * 1000).toISOString();
      await docClient.send(
        new UpdateCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId },
          UpdateExpression: 'SET scheduledRevealAt = :scheduledRevealAt',
          ExpressionAttributeValues: {
            ':scheduledRevealAt': scheduledRevealAt,
          },
        })
      );
    } else {
      logger.info('Auto-reveal already scheduled, skipping duplicate countdown');
    }
  }

  logger.info('Broadcasting round update', { roomId, roundId, votesCount: votes.length });

  // Send acknowledgment to voter
  try {
    await sendToConnection(event, connectionId, {
      type: 'ack',
      payload: { message: 'Vote recorded', roundId },
    });
  } catch (ackError) {
    logger.warn('Failed to send acknowledgment to voter', { error: ackError });
    // Continue anyway
  }

  // Broadcast round update to all participants
  try {
    await broadcastToRoom(event, roomId, {
      type: 'roundUpdate',
      payload: { round, votes },
    });
    logger.info('Broadcast completed');
  } catch (broadcastError) {
    logger.error('Failed to broadcast round update', { error: broadcastError });
    // Still return success since vote was recorded
  }

  return { message: 'Vote recorded' };
}

async function handleReveal(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'reveal' }
) {
  const logger = createLogger();
  const { connectionId } = event.requestContext;
  const { roundId } = message.payload;

  // Find participant by connectionId
  const queryResult = await docClient.send(
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

  const participant = queryResult.Items?.[0] as Participant | undefined;
  if (!participant) {
    throw new Error('Participant not found');
  }
  logger.info('Reveal participant found', {
    roomId: participant.roomId,
    isModerator: participant.isModerator,
  });

  const { roomId } = participant;

  // Get the round first to check for scheduled auto-reveal
  const roundResult = await docClient.send(
    new GetCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId },
    })
  );

  const item = roundResult.Item;
  if (!item) {
    throw new Error('Round not found');
  }

  // Check if this is an auto-reveal (scheduledRevealAt is set and in the past)
  const isAutoReveal = item.scheduledRevealAt && new Date(item.scheduledRevealAt) <= new Date();
  logger.info('Auto-reveal check', { isAutoReveal, roomId });

  // Fetch room to check allowAllParticipantsToReveal setting (cached)
  const room = (await getRoomWithCache(roomId)) as Room | undefined;
  if (!room) {
    throw new Error('Room not found');
  }

  // Check if participant is moderator or room allows all participants to reveal
  // OR if this is an auto-reveal (scheduled reveal time has passed)
  logger.info('Reveal permission check', {
    isModerator: participant.isModerator,
    isAutoReveal,
  });
  if (!participant.isModerator && !room.allowAllParticipantsToReveal && !isAutoReveal) {
    throw new Error('Only moderators can reveal votes');
  }
  // Map DynamoDB attributes to Round interface
  const round = {
    id: item.roundId || item.id,
    roomId: item.roomId,
    title: item.title,
    description: item.description,
    startedAt: item.startedAt,
    revealedAt: item.revealedAt,
    isRevealed: item.isRevealed,
    scheduledRevealAt: item.scheduledRevealAt || undefined,
  };

  if (round.isRevealed) {
    throw new Error('Round is already revealed');
  }

  // Update round as revealed
  logger.info('Revealing round', { roomId, roundId, isAutoReveal });
  const revealedAt = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId },
      UpdateExpression: 'SET isRevealed = :true, revealedAt = :revealedAt REMOVE scheduledRevealAt',
      ExpressionAttributeValues: {
        ':true': true,
        ':revealedAt': revealedAt,
      },
    })
  );

  // Invalidate active round cache since round is now revealed
  cacheManager.invalidateActiveRound(roomId);
  // Delete ACTIVE coordination item as round is no longer active
  await docClient.send(
    new DeleteCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId: 'ACTIVE' },
    })
  );
  round.isRevealed = true;
  round.revealedAt = revealedAt;

  // Fetch all votes for this round (consistent read to ensure we see all votes)
  const votesResult = await docClient.send(
    new QueryCommand({
      TableName: VOTES_TABLE,
      KeyConditionExpression: 'roundId = :roundId',
      ExpressionAttributeValues: {
        ':roundId': roundId,
      },
      ConsistentRead: true,
    })
  );

  const votes = (votesResult.Items as Vote[]) || [];

  // Debug: log participants before broadcast
  const participants = await cacheManager.getParticipantsWithCache(roomId);
  logger.info('Reveal broadcast participants', { count: participants.length });

  // Broadcast round update with revealed votes
  await broadcastToRoom(event, roomId, {
    type: 'roundUpdate',
    payload: { round, votes },
  });

  return { message: 'Votes revealed' };
}

async function handleJoin(
  event: APIGatewayProxyEvent,
  _message: WebSocketMessage & { type: 'join' }
) {
  const { connectionId } = event.requestContext;

  // Find participant by connectionId
  const queryResult = await docClient.send(
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

  const participant = queryResult.Items?.[0] as Participant | undefined;
  if (!participant) {
    throw new Error('Participant not found');
  }

  const { roomId } = participant;

  // Fetch all participants in the room
  const participantsResult = await docClient.send(
    new QueryCommand({
      TableName: PARTICIPANTS_TABLE,
      KeyConditionExpression: 'roomId = :roomId',
      ExpressionAttributeValues: {
        ':roomId': roomId,
      },
    })
  );

  const participants = (participantsResult.Items as Participant[]) || [];

  // Broadcast participant list to everyone in the room
  await broadcastToRoom(event, roomId, {
    type: 'participantList',
    payload: { participants },
  });

  return { message: 'Joined' };
}

async function handleUpdateParticipant(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'updateParticipant' }
) {
  const logger = createLogger();
  const { connectionId } = event.requestContext;
  const { name } = message.payload;

  if (!name || typeof name !== 'string') {
    logger.error('Invalid name in updateParticipant');
    throw new Error('Invalid name');
  }

  // Find participant by connectionId
  const queryResult = await docClient.send(
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

  const participant = queryResult.Items?.[0] as Participant | undefined;
  if (!participant) {
    logger.error('Participant not found for connectionId');
    throw new Error('Participant not found');
  }

  logger.info('Found participant for update', { roomId: participant.roomId });
  const { roomId, participantId } = participant;
  const avatarSeed = createAvatarSeed(name);

  // Update participant name and avatarSeed
  logger.info('Updating participant name', { roomId });
  await docClient.send(
    new UpdateCommand({
      TableName: PARTICIPANTS_TABLE,
      Key: { roomId, participantId },
      UpdateExpression: 'SET #name = :name, avatarSeed = :avatarSeed',
      ExpressionAttributeNames: {
        '#name': 'name',
      },
      ExpressionAttributeValues: {
        ':name': name,
        ':avatarSeed': avatarSeed,
      },
    })
  );
  logger.debug('Participant updated in DynamoDB');

  // Fetch all participants in the room
  const participantsResult = await docClient.send(
    new QueryCommand({
      TableName: PARTICIPANTS_TABLE,
      KeyConditionExpression: 'roomId = :roomId',
      ExpressionAttributeValues: {
        ':roomId': roomId,
      },
    })
  );

  const participants = (participantsResult.Items as Participant[]) || [];

  // Broadcast participant list to everyone in the room
  logger.info('Broadcasting participantList', { roomId, count: participants.length });
  await broadcastToRoom(event, roomId, {
    type: 'participantList',
    payload: { participants },
  });
  logger.info('Broadcast completed');

  // Send confirmation to the sender
  try {
    await sendToConnection(event, connectionId, {
      type: 'participantUpdated',
      payload: { success: true, name },
    });
  } catch (error) {
    logger.error('Failed to send confirmation', { error });
  }

  return { message: 'Participant updated' };
}

async function handleNewRound(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'newRound' }
) {
  const logger = createLogger();
  const { connectionId } = event.requestContext;
  const { title, description } = message.payload;

  // Find participant by connectionId
  const queryResult = await docClient.send(
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

  const participant = queryResult.Items?.[0] as Participant | undefined;
  if (!participant) {
    throw new Error('Participant not found');
  }

  if (!participant.isModerator) {
    throw new Error('Only moderators can start a new round');
  }

  const { roomId } = participant;

  // Check for existing unrevealed rounds (should be at most one, but handle all)
  const activeRoundsResult = await docClient.send(
    new QueryCommand({
      TableName: ROUNDS_TABLE,
      KeyConditionExpression: 'roomId = :roomId',
      FilterExpression: 'isRevealed = :false',
      ExpressionAttributeValues: {
        ':roomId': roomId,
        ':false': false,
      },
      ConsistentRead: true,
    })
  );

  // If there are existing unrevealed rounds, mark them all as revealed first
  if (activeRoundsResult.Items && activeRoundsResult.Items.length > 0) {
    logger.info('Found unrevealed rounds, marking as revealed', {
      count: activeRoundsResult.Items.length,
    });

    const revealedAt = new Date().toISOString();

    // Atomically mark all unrevealed rounds as revealed
    const transactItems = activeRoundsResult.Items.map((existingItem) => {
      const existingRoundId = existingItem.roundId || existingItem.id;
      return {
        Update: {
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId: existingRoundId },
          UpdateExpression:
            'SET isRevealed = :true, revealedAt = :revealedAt REMOVE scheduledRevealAt',
          ExpressionAttributeValues: {
            ':true': true,
            ':revealedAt': revealedAt,
          },
        },
      };
    });

    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));

    // Fetch votes and broadcast for each existing round (non-transactional reads)
    for (const existingItem of activeRoundsResult.Items) {
      const existingRoundId = existingItem.roundId || existingItem.id;

      const existingVotesResult = await docClient.send(
        new QueryCommand({
          TableName: VOTES_TABLE,
          KeyConditionExpression: 'roundId = :roundId',
          ExpressionAttributeValues: {
            ':roundId': existingRoundId,
          },
          ConsistentRead: true,
        })
      );
      const existingVotes = (existingVotesResult.Items as Vote[]) || [];

      const existingRound: Round = {
        id: existingRoundId,
        roomId: existingItem.roomId,
        title: existingItem.title,
        description: existingItem.description,
        startedAt: existingItem.startedAt,
        revealedAt,
        isRevealed: true,
        scheduledRevealAt: undefined,
      };

      await broadcastToRoom(event, roomId, {
        type: 'roundUpdate',
        payload: { round: existingRound, votes: existingVotes },
      });
    }
    // Invalidate active round cache since we marked existing rounds as revealed
    cacheManager.invalidateActiveRound(roomId);
  }

  // Always create a new round with new ID
  const roundId = uuidv4();
  const now = new Date().toISOString();
  const round: Round = {
    id: roundId,
    roomId,
    title,
    description,
    startedAt: now,
    isRevealed: false,
    scheduledRevealAt: undefined,
  };

  await docClient.send(
    new PutCommand({
      TableName: ROUNDS_TABLE,
      Item: {
        ...round,
        roundId,
      },
    })
  );

  // Update ACTIVE coordination item to point to the new round
  await docClient.send(
    new PutCommand({
      TableName: ROUNDS_TABLE,
      Item: {
        roomId,
        roundId: 'ACTIVE',
        activeRoundId: roundId,
        updatedAt: now,
      },
    })
  );

  logger.info('Created new round', { roundId });
  // Invalidate active round cache since we created a new active round
  cacheManager.invalidateActiveRound(roomId);

  // Fetch any existing votes for this round (consistent read)
  const votesResult = await docClient.send(
    new QueryCommand({
      TableName: VOTES_TABLE,
      KeyConditionExpression: 'roundId = :roundId',
      ExpressionAttributeValues: {
        ':roundId': roundId,
      },
      ConsistentRead: true,
    })
  );
  const votes = (votesResult.Items as Vote[]) || [];

  // Broadcast round update
  await broadcastToRoom(event, roomId, {
    type: 'roundUpdate',
    payload: { round, votes },
  });

  return { message: 'New round created or updated' };
}

async function handleUpdateRound(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'updateRound' }
) {
  const { connectionId } = event.requestContext;
  const { roundId, title, description } = message.payload;

  if (!roundId) {
    throw new Error('Missing roundId');
  }

  // Find participant by connectionId
  const queryResult = await docClient.send(
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

  const participant = queryResult.Items?.[0] as Participant | undefined;
  if (!participant) {
    throw new Error('Participant not found');
  }

  const { roomId } = participant;

  // Verify round belongs to room
  const roundResult = await docClient.send(
    new GetCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId },
    })
  );

  const item = roundResult.Item;
  if (!item) {
    throw new Error('Round not found');
  }

  // Build update expression dynamically based on provided fields
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, string> = {};

  if (title !== undefined) {
    updateExpressions.push('#title = :title');
    expressionAttributeNames['#title'] = 'title';
    expressionAttributeValues[':title'] = title;
  }
  if (description !== undefined) {
    updateExpressions.push('#description = :description');
    expressionAttributeNames['#description'] = 'description';
    expressionAttributeValues[':description'] = description;
  }

  if (updateExpressions.length === 0) {
    throw new Error('No fields to update');
  }

  await docClient.send(
    new UpdateCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  // Fetch updated round and votes
  const updatedRoundResult = await docClient.send(
    new GetCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId },
    })
  );
  const updatedItem = updatedRoundResult.Item!;
  const round: Round = {
    id: updatedItem.roundId || updatedItem.id,
    roomId: updatedItem.roomId,
    title: updatedItem.title,
    description: updatedItem.description,
    startedAt: updatedItem.startedAt,
    revealedAt: updatedItem.revealedAt,
    isRevealed: updatedItem.isRevealed,
    scheduledRevealAt: updatedItem.scheduledRevealAt || undefined,
  };

  const votesResult = await docClient.send(
    new QueryCommand({
      TableName: VOTES_TABLE,
      KeyConditionExpression: 'roundId = :roundId',
      ExpressionAttributeValues: {
        ':roundId': roundId,
      },
    })
  );
  const votes = (votesResult.Items as Vote[]) || [];

  // Broadcast round update
  await broadcastToRoom(event, roomId, {
    type: 'roundUpdate',
    payload: { round, votes },
  });

  return { message: 'Round updated' };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const logger = createLogger();
  let message: WebSocketMessage;

  try {
    message = JSON.parse(event.body || '{}');
  } catch (error) {
    logger.error('Failed to parse JSON', { error, body: event.body });
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON message' }),
    };
  }

  // Validate message structure
  const validationResult = safeParseWebSocketMessage(message);
  if (!validationResult.success) {
    const zodError = validationResult.error as {
      issues?: Array<{ path: string[]; message: string }>;
      errors?: Array<{ path: string[]; message: string }>;
    };
    const issues = zodError.issues || zodError.errors;
    logger.error('Message validation failed', { issues });
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Invalid message format',
        details: issues
          ? issues.map((e) => `${e.path.join('.')}: ${e.message}`)
          : ['Validation failed'],
      }),
    };
  }

  // Use validated message (type-safe)
  const validatedMessage = validationResult.data;
  message = validatedMessage;

  // Rate limiting: 20 messages per second per connection per message type
  const connectionId = event.requestContext.connectionId;
  const allowed = await checkRateLimit(connectionId, message.type);
  if (!allowed) {
    return {
      statusCode: 429,
      body: createErrorResponse('Rate limit exceeded', 'RATE_LIMIT'),
    };
  }

  try {
    let result;
    logger.info('Processing message type', { type: message.type });
    switch (message.type) {
      case 'vote':
        result = await handleVote(event, message);
        break;
      case 'reveal':
        result = await handleReveal(event, message);
        break;
      case 'join':
        result = await handleJoin(event, message);
        break;
      case 'updateParticipant':
        result = await handleUpdateParticipant(event, message);
        break;
      case 'newRound':
        result = await handleNewRound(event, message);
        break;
      case 'updateRound':
        result = await handleUpdateRound(event, message);
        break;
      default:
        return {
          statusCode: 400,
          body: createErrorResponse(`Unsupported message type: ${message.type}`),
        };
    }

    return {
      statusCode: 200,
      body: createSuccessResponse(result.message || 'Success'),
    };
  } catch (error: unknown) {
    logger.error('Handler error', { error });
    const e = error as { name?: string; message?: string };

    // Check for conditional check failure (duplicate vote)
    if (e.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 400,
        body: createErrorResponse('Already voted in this round', 'DUPLICATE_VOTE'),
      };
    }

    // Custom error messages
    if (e.message === 'Participant not found') {
      return {
        statusCode: 404,
        body: createErrorResponse('Participant not found', 'PARTICIPANT_NOT_FOUND'),
      };
    }
    if (e.message === 'Round not found') {
      return {
        statusCode: 404,
        body: createErrorResponse('Round not found', 'ROUND_NOT_FOUND'),
      };
    }
    if (e.message === 'Round is already revealed') {
      return {
        statusCode: 400,
        body: createErrorResponse('Round is already revealed', 'ROUND_ALREADY_REVEALED'),
      };
    }
    if (e.message === 'Missing vote value') {
      return {
        statusCode: 400,
        body: createErrorResponse('Missing vote value', 'MISSING_VOTE_VALUE'),
      };
    }

    return {
      statusCode: 500,
      body: createErrorResponse('Internal server error', 'INTERNAL_ERROR'),
    };
  }
};
