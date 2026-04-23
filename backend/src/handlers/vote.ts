// Vote handler for WebSocket messages
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
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

const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(client);

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
  const MAX_RETRIES = 3;
  console.log('getOrCreateActiveRound called for room:', roomId, 'retry:', retryCount);
  // Try cache first
  const cachedRound = await cacheManager.getActiveRoundWithCache(roomId);
  if (cachedRound) {
    console.log('Found cached round:', cachedRound.id);
    return { roundId: cachedRound.id, round: cachedRound };
  }
  console.log('No cached round, creating new one');

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
    console.log('Successfully created new round:', newRoundId, 'for room:', roomId);
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
        console.warn('Active item missing activeRoundId, retrying', { roomId, activeItem });
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
        console.error('Round item missing for activeRoundId, cleaning up', {
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

      console.log('Found existing round created by another participant:', existingRoundId);
      return { roundId: existingRoundId, round };
    }
    throw error;
  }
}

async function handleVote(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'vote' }
) {
  console.log('=== VOTE HANDLER START ===');
  console.log('Connection ID:', event.requestContext.connectionId);
  console.log('Message payload:', JSON.stringify(message.payload));
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
  console.log('Found participant:', {
    participantId: participant.participantId,
    roomId: participant.roomId,
    isModerator: participant.isModerator,
    connectionId: participant.connectionId,
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
  console.log('RoundId provided:', roundId);
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
    console.log('No roundId provided, finding or creating active round');
    const activeRoundResult = await getOrCreateActiveRound(roomId);
    console.log('getOrCreateActiveRound result:', {
      roundId: activeRoundResult.roundId,
      round: activeRoundResult.round,
      hasRound: !!activeRoundResult.round,
      roundKeys: activeRoundResult.round ? Object.keys(activeRoundResult.round) : [],
    });
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
  console.log('Round object for voting:', JSON.stringify(round));
  // Create vote
  console.log('Creating vote with roundId:', roundId, 'participantId:', participantId);
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
  console.log('Attempting vote transaction...', { roomId, roundId, participantId, voteId });
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
    console.log('Vote transaction successful for participant:', participantId, 'roundId:', roundId);
  } catch (transactionError) {
    console.error('Vote transaction failed:', transactionError);
    console.error('Transaction details:', {
      roomId,
      roundId,
      participantId,
      voteId,
      idempotencyKey,
    });
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

  // Log participant details for debugging
  console.log(
    'All participants:',
    participants.map((p) => ({
      id: p.id,
      name: p.name,
      connectionId: p.connectionId,
      isModerator: p.isModerator,
    }))
  );
  console.log(
    'Active participants:',
    activeParticipants.map((p) => ({ id: p.id, name: p.name, connectionId: p.connectionId }))
  );

  // Fetch all votes for this round to broadcast, with aggressive retry for consistency
  let votes: Vote[] = [];
  const expectedVoteCount = activeParticipants.length;
  console.log(
    `Expected vote count: ${expectedVoteCount} (active participants), roundId: ${roundId}`
  );

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
    console.log(
      `Votes query attempt ${attempt + 1}:`,
      votes.length,
      'votes',
      `(${queryDuration}ms)`
    );
    console.log(
      `Votes details:`,
      votes.map((v) => ({ participantId: v.participantId, value: v.value, voteId: v.id }))
    );

    // Log which votes we found vs expected participants
    const foundParticipantIds = votes.map((v) => v.participantId);
    const missingParticipantIds = activeParticipants
      .filter((p) => !foundParticipantIds.includes(p.id))
      .map((p) => p.id);

    if (missingParticipantIds.length > 0) {
      console.log(`Missing votes for participants: ${missingParticipantIds.join(', ')}`);
    }

    // If we have all expected votes, break immediately
    if (votes.length >= expectedVoteCount && expectedVoteCount > 0) {
      console.log(`Found all ${expectedVoteCount} expected votes`);
      break;
    }

    // If no active participants (shouldn't happen), break
    if (expectedVoteCount === 0) {
      console.log('No active participants, no votes expected');
      break;
    }

    // Wait before retrying (exponential backoff with cap)
    const delayMs = Math.min(BASE_DELAY_MS * Math.pow(1.5, attempt), MAX_DELAY_MS);
    console.log(`Waiting ${delayMs}ms before retry (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const totalQueryDuration = Date.now() - totalQueryStart;
  console.log(`Total votes query duration: ${totalQueryDuration}ms, attempts: ${attemptsUsed}`);

  // Check if we're still missing votes after all retries
  const foundParticipantIds = votes.map((v) => v.participantId);
  const missingParticipantIdsAfterRetry = activeParticipants
    .filter((p) => !foundParticipantIds.includes(p.id))
    .map((p) => p.id);

  // If still missing votes after all retries, try one more time with longer delay
  if (missingParticipantIdsAfterRetry.length > 0 && votes.length < expectedVoteCount) {
    console.warn(
      `🚨 After ${MAX_ATTEMPTS} retries, still missing votes for participants: ${missingParticipantIdsAfterRetry.join(', ')}`
    );
    console.warn(`Waiting 2 seconds for final attempt...`);
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
    console.log(`Final votes query after 5s wait:`, votes.length, 'votes');

    const finalFoundParticipantIds = votes.map((v) => v.participantId);
    const finalMissingParticipantIds = activeParticipants
      .filter((p) => !finalFoundParticipantIds.includes(p.id))
      .map((p) => p.id);

    if (finalMissingParticipantIds.length > 0) {
      console.error(
        `💥 CRITICAL: After ${MAX_ATTEMPTS} retries + 5s wait, STILL missing votes for participants: ${finalMissingParticipantIds.join(', ')}`
      );
      console.error(
        `Broadcasting with only ${votes.length} of ${expectedVoteCount} expected votes. Database consistency issue! Round: ${roundId}`
      );
    } else {
      console.log(`✅ Successfully retrieved all ${expectedVoteCount} votes after final wait`);
    }
  } else if (votes.length === expectedVoteCount) {
    console.log(`✅ Successfully retrieved all ${expectedVoteCount} votes for round ${roundId}`);
  }

  console.log(
    'Votes for round:',
    roundId,
    votes.map((v) => ({ participantId: v.participantId, value: v.value, voteId: v.id }))
  );

  console.log(
    'Auto-reveal check participants:',
    participants.map((p) => ({
      id: p.id,
      name: p.name,
      isModerator: p.isModerator,
      connectionId: p.connectionId,
    }))
  );
  console.log(
    'Auto-reveal check active participants:',
    activeParticipants.map((p) => ({ id: p.id, name: p.name, connectionId: p.connectionId }))
  );
  console.log(
    'Auto-reveal check votes:',
    votes.length,
    'votes',
    votes.map((v) => ({ participantId: v.participantId, value: v.value }))
  );
  const allVoted = votes.length === activeParticipants.length && activeParticipants.length > 0;
  console.log(
    `All voted check: votes=${votes.length}, participants=${participants.length}, activeParticipants=${activeParticipants.length}, allVoted=${allVoted}, round.isRevealed=${round.isRevealed}`
  );
  // Detailed debug
  console.log(
    'Active participant IDs:',
    activeParticipants.map((p) => p.id)
  );
  console.log(
    'Vote participant IDs:',
    votes.map((v) => v.participantId)
  );
  console.log(
    'Missing voters:',
    activeParticipants.filter((p) => !votes.find((v) => v.participantId === p.id)).map((p) => p.id)
  );

  // Fetch room to check auto-reveal settings (cached)
  const roomSettings = (await getRoomWithCache(roomId)) as Room | undefined;
  console.log('Auto-reveal room settings:', {
    autoRevealEnabled: roomSettings?.autoRevealEnabled,
    countdownSeconds: roomSettings?.autoRevealCountdownSeconds,
    allowAllParticipantsToReveal: roomSettings?.allowAllParticipantsToReveal,
    maxParticipants: roomSettings?.maxParticipants,
  });
  const autoRevealEnabled = roomSettings?.autoRevealEnabled !== false; // default: true
  const countdownSeconds = roomSettings?.autoRevealCountdownSeconds ?? 3; // default: 3

  // If everyone voted, auto-reveal is enabled, and round not yet revealed
  if (allVoted && autoRevealEnabled && !round.isRevealed) {
    console.log('All participants voted, checking if auto-reveal already scheduled', {
      roomId,
      roundId,
      countdownSeconds,
      scheduledRevealAt: round.scheduledRevealAt,
    });

    // Only schedule auto-reveal if not already scheduled (prevents duplicate countdowns)
    if (!round.scheduledRevealAt) {
      console.log('Scheduling auto-reveal', {
        roomId,
        roundId,
        countdownSeconds,
      });

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
      console.log('Auto-reveal already scheduled, skipping duplicate countdown', {
        scheduledRevealAt: round.scheduledRevealAt,
      });
    }
  }

  console.log('Broadcasting round update', { roomId, roundId, votesCount: votes.length });
  const { domainName, stage } = event.requestContext;
  console.log('Endpoint info:', { domainName, stage });

  // Send acknowledgment to voter
  try {
    await sendToConnection(event, connectionId, {
      type: 'ack',
      payload: { message: 'Vote recorded', roundId },
    });
    console.log('Acknowledgment sent to voter:', connectionId);
  } catch (ackError) {
    console.warn('Failed to send acknowledgment to voter:', ackError);
    // Continue anyway
  }

  // Broadcast round update to all participants
  try {
    await broadcastToRoom(event, roomId, {
      type: 'roundUpdate',
      payload: { round, votes },
    });
    console.log('Broadcast completed');
  } catch (broadcastError) {
    console.error('Failed to broadcast round update:', broadcastError);
    // Still return success since vote was recorded
  }

  return { message: 'Vote recorded' };
}

async function handleReveal(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'reveal' }
) {
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
  console.log('Reveal participant found:', {
    participantId: participant.id,
    name: participant.name,
    connectionId: participant.connectionId,
    isModerator: participant.isModerator,
    roomId: participant.roomId,
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
  console.log('Auto-reveal check:', {
    scheduledRevealAt: item.scheduledRevealAt,
    scheduledRevealAtDate: item.scheduledRevealAt
      ? new Date(item.scheduledRevealAt).toISOString()
      : null,
    now: new Date().toISOString(),
    isAutoReveal,
    participantIsModerator: participant.isModerator,
    participantId: participant.id,
    participantName: participant.name,
  });

  // Fetch room to check allowAllParticipantsToReveal setting (cached)
  console.log('Fetching room for reveal, roomId:', roomId);
  const room = (await getRoomWithCache(roomId)) as Room | undefined;
  console.log(
    'Room fetched:',
    room ? 'found' : 'not found',
    room ? { id: room.id, autoRevealEnabled: room.autoRevealEnabled } : null
  );
  if (!room) {
    throw new Error('Room not found');
  }

  // Check if participant is moderator or room allows all participants to reveal
  // OR if this is an auto-reveal (scheduled reveal time has passed)
  console.log('Reveal permission check:', {
    participantIsModerator: participant.isModerator,
    roomAllowAllParticipantsToReveal: room.allowAllParticipantsToReveal,
    isAutoReveal,
    allowed: participant.isModerator || room.allowAllParticipantsToReveal || isAutoReveal,
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
  console.log('Revealing round:', { roomId, roundId, isAutoReveal });
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
  console.log(
    'Reveal broadcast participants:',
    participants.map((p) => ({
      id: p.id,
      name: p.name,
      connectionId: p.connectionId,
      isModerator: p.isModerator,
    }))
  );
  const moderator = participants.find((p) => p.isModerator);
  console.log(
    'Moderator participant:',
    moderator
      ? {
          id: moderator.id,
          connectionId: moderator.connectionId,
          name: moderator.name,
        }
      : 'No moderator found'
  );

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
  console.log('========== handleUpdateParticipant START ==========');
  console.log('handleUpdateParticipant called', {
    connectionId: event.requestContext.connectionId,
    name: message.payload.name,
    message: JSON.stringify(message),
  });
  const { connectionId } = event.requestContext;
  const { name } = message.payload;

  if (!name || typeof name !== 'string') {
    console.error('Invalid name in updateParticipant:', name);
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
    console.error('Participant not found for connectionId:', connectionId);
    throw new Error('Participant not found');
  }

  console.log('Found participant:', {
    participantId: participant.participantId,
    roomId: participant.roomId,
    currentName: participant.name,
  });
  const { roomId, participantId } = participant;
  const avatarSeed = createAvatarSeed(name);

  // Update participant name and avatarSeed
  console.log('Updating participant in DynamoDB:', {
    roomId,
    participantId,
    newName: name,
    avatarSeed,
  });
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
  console.log('Participant updated successfully');

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
  console.log('Fetched participants for broadcast:', participants.length, 'participants');

  // Broadcast participant list to everyone in the room
  console.log('Broadcasting participantList to room:', roomId);
  await broadcastToRoom(event, roomId, {
    type: 'participantList',
    payload: { participants },
  });
  console.log('Broadcast completed');

  // Send confirmation to the sender
  try {
    await sendToConnection(event, connectionId, {
      type: 'participantUpdated',
      payload: { success: true, name },
    });
    console.log('Confirmation sent to sender');
  } catch (error) {
    console.error('Failed to send confirmation:', error);
  }

  return { message: 'Participant updated' };
}

async function handleNewRound(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'newRound' }
) {
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
    console.log(`Found ${activeRoundsResult.Items.length} unrevealed rounds, marking as revealed`);

    for (const existingItem of activeRoundsResult.Items) {
      const existingRoundId = existingItem.roundId || existingItem.id;
      console.log('Marking unrevealed round as revealed:', existingRoundId);

      const revealedAt = new Date().toISOString();

      // Mark existing round as revealed and clear any scheduled reveal
      await docClient.send(
        new UpdateCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId: existingRoundId },
          UpdateExpression:
            'SET isRevealed = :true, revealedAt = :revealedAt REMOVE scheduledRevealAt',
          ExpressionAttributeValues: {
            ':true': true,
            ':revealedAt': revealedAt,
          },
        })
      );

      // Fetch votes for the existing round
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

      // Broadcast the existing round as revealed
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

      console.log('Existing round marked as revealed:', existingRoundId);
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

  console.log('Created new round:', roundId);
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
  console.log('========== VOTE HANDLER INVOKED ==========');
  console.log('Vote handler updated for new message types');
  console.log('Vote handler invoked', {
    connectionId: event.requestContext.connectionId,
    routeKey: event.requestContext.routeKey,
    body: event.body,
  });
  try {
    console.log('Raw body (parsed):', event.body ? JSON.parse(event.body) : null);
  } catch (_e) {
    console.log('Raw body (cannot parse):', event.body);
  }
  let message: WebSocketMessage;

  try {
    message = JSON.parse(event.body || '{}');
    console.log('Parsed message:', { type: message.type, payload: message.payload });
  } catch (error) {
    console.error('Failed to parse JSON:', error, 'body:', event.body);
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
    console.error('Message validation failed:', issues);
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
    console.log('Processing message type:', message.type);
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
    console.error('Handler error:', error);
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
