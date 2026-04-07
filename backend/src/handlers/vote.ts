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
import { Vote, Round, WebSocketMessage, Participant } from '@estimatenest/shared';
import { broadcastToRoom } from '../utils/broadcast';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;
const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;

async function handleVote(
  event: APIGatewayProxyEvent,
  message: WebSocketMessage & { type: 'vote' }
) {
  const { connectionId } = event.requestContext;
  const { roundId: requestedRoundId, value } = message.payload;

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
  console.log('Found participant:', { participantId: participant.participantId, roomId: participant.roomId, isModerator: participant.isModerator, connectionId: participant.connectionId });

  const { roomId, participantId } = participant;

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
    round = roundResult.Item as Round;
    if (!round) {
      throw new Error('Round not found');
    }
    if (round.isRevealed) {
      throw new Error('Round is already revealed');
    }
  } else {
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
      round = activeRoundsResult.Items[0] as Round;
      roundId = round.id;
    } else {
      // Create new round
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
            ConditionExpression: 'attribute_not_exists(participantId)', // Prevent duplicate votes
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

  const participant = queryResult.Items?.[0];
  if (!participant) {
    throw new Error('Participant not found');
  }
  console.log('Reveal participant:', participant);

  const { roomId } = participant;

  // Get the round
  const roundResult = await docClient.send(
    new GetCommand({
      TableName: ROUNDS_TABLE,
      Key: { roomId, roundId },
    })
  );

  const round = roundResult.Item as Round;
  if (!round) {
    throw new Error('Round not found');
  }

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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let message: WebSocketMessage;

  try {
    message = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON message' }),
    };
  }

  try {
    let result;
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
