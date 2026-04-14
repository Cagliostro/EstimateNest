// Vote handler for WebSocket messages
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  Vote,
  Round,
  WebSocketMessage,
  Participant,
  createAvatarSeed,
  Room,
} from '@estimatenest/shared';
import { broadcastToRoom, sendToConnection } from '../utils/broadcast';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;
const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;
const ROOMS_TABLE = process.env.ROOMS_TABLE!;

async function handleVote(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'vote' }
) {
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
    };
    if (round.isRevealed) {
      throw new Error('Round is already revealed');
    }
  } else {
    console.log('No roundId provided, finding or creating active round');
    // Find or create active round
    const activeRoundsResult = await docClient.send(
      new QueryCommand({
        TableName: ROUNDS_TABLE,
        KeyConditionExpression: 'roomId = :roomId',
        FilterExpression: 'isRevealed = :false',
        ExpressionAttributeValues: {
          ':roomId': roomId,
          ':false': false,
        },
        Limit: 1,
      })
    );

    if (activeRoundsResult.Items && activeRoundsResult.Items.length > 0) {
      const item = activeRoundsResult.Items[0];
      console.log('Active round found:', item.roundId || item.id);
      // Map DynamoDB attributes to Round interface
      round = {
        id: item.roundId || item.id,
        roomId: item.roomId,
        title: item.title,
        description: item.description,
        startedAt: item.startedAt,
        revealedAt: item.revealedAt,
        isRevealed: item.isRevealed,
      };
      roundId = round.id;
    } else {
      // Create new round
      console.log('No active round, creating new round');
      roundId = uuidv4();
      const now = new Date().toISOString();
      round = {
        id: roundId,
        roomId,
        startedAt: now,
        isRevealed: false,
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
    }
  }

  // Ensure roundId is defined
  if (!roundId) {
    throw new Error('roundId is undefined');
  }
  // Create vote
  console.log('Creating vote with roundId:', roundId, 'participantId:', participantId);
  const voteId = uuidv4();
  const votedAt = new Date().toISOString();
  const vote: Vote = {
    id: voteId,
    roundId,
    participantId,
    value,
    votedAt,
  };

  // Store vote and update round in transaction
  console.log('Storing vote:', vote);
  console.log('Votes table key schema: roundId (partition), participantId (sort)');
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: VOTES_TABLE,
            Item: {
              ...vote,
            },
            ConditionExpression:
              'attribute_not_exists(roundId) AND attribute_not_exists(participantId)', // Prevent duplicate votes in same round
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

  // Fetch all votes for this round to broadcast
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

  // Check if everyone has voted and auto-reveal is enabled
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
  const allVoted = votes.length === participants.length && participants.length > 0;

  // Fetch room to check auto-reveal settings
  const roomResult = await docClient.send(
    new GetCommand({
      TableName: ROOMS_TABLE,
      Key: { id: roomId, sk: 'META' },
    })
  );
  const room = roomResult.Item as Room | undefined;
  const autoRevealEnabled = room?.autoRevealEnabled !== false; // default: true
  const countdownSeconds = room?.autoRevealCountdownSeconds ?? 3; // default: 3

  // If everyone voted, auto-reveal is enabled, and round not yet revealed
  if (allVoted && autoRevealEnabled && !round.isRevealed) {
    console.log('All participants voted, scheduling auto-reveal', {
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
  }

  console.log('Broadcasting round update', { roomId, roundId, votesCount: votes.length });
  const { domainName, stage } = event.requestContext;
  console.log('Endpoint info:', { domainName, stage });

  // Broadcast round update to all participants
  await broadcastToRoom(event, roomId, {
    type: 'roundUpdate',
    payload: { round, votes },
  });

  console.log('Broadcast completed');

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

  const { roomId } = participant;

  // Fetch room to check allowAllParticipantsToReveal setting
  const roomResult = await docClient.send(
    new GetCommand({
      TableName: ROOMS_TABLE,
      Key: { id: roomId, sk: 'META' },
    })
  );

  const room = roomResult.Item as Room | undefined;
  if (!room) {
    throw new Error('Room not found');
  }

  // Check if participant is moderator or room allows all participants to reveal
  if (!participant.isModerator && !room.allowAllParticipantsToReveal) {
    throw new Error('Only moderators can reveal votes');
  }

  // Get the round
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
  const round = {
    id: item.roundId || item.id,
    roomId: item.roomId,
    title: item.title,
    description: item.description,
    startedAt: item.startedAt,
    revealedAt: item.revealedAt,
    isRevealed: item.isRevealed,
  };

  if (round.isRevealed) {
    throw new Error('Round is already revealed');
  }

  // Update round as revealed
  console.log('Revealing round:', { roomId, roundId });
  const revealedAt = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId },
      UpdateExpression: 'SET isRevealed = :true, revealedAt = :revealedAt',
      ExpressionAttributeValues: {
        ':true': true,
        ':revealedAt': revealedAt,
      },
    })
  );

  round.isRevealed = true;
  round.revealedAt = revealedAt;

  // Fetch all votes for this round
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
      ConsistentRead: true,
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
  const roundId = uuidv4();
  const now = new Date().toISOString();
  const round: Round = {
    id: roundId,
    roomId,
    title,
    description,
    startedAt: now,
    isRevealed: false,
  };

  // Create new round
  await docClient.send(
    new PutCommand({
      TableName: ROUNDS_TABLE,
      Item: {
        ...round,
        roundId,
      },
    })
  );

  // Broadcast round update with empty votes
  await broadcastToRoom(event, roomId, {
    type: 'roundUpdate',
    payload: { round, votes: [] },
  });

  return { message: 'New round created' };
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
  } catch (e) {
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
          body: JSON.stringify({ error: `Unsupported message type: ${message.type}` }),
        };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error: unknown) {
    console.error('Handler error:', error);
    const e = error as { name?: string; message?: string };

    // Check for conditional check failure (duplicate vote)
    if (e.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Already voted in this round' }),
      };
    }

    // Custom error messages
    if (e.message === 'Participant not found') {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Participant not found' }),
      };
    }
    if (e.message === 'Round not found') {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Round not found' }),
      };
    }
    if (e.message === 'Round is already revealed') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Round is already revealed' }),
      };
    }
    if (e.message === 'Missing vote value') {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing vote value' }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
