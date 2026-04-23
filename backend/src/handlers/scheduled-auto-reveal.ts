import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  ApiGatewayManagementApiServiceException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { getCacheManager } from '../utils/cache';
import { WebSocketMessage, Round, Vote, Participant } from '@estimatenest/shared';

const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(client);
const cacheManager = getCacheManager();

const ROUNDS_TABLE = process.env.ROUNDS_TABLE!;
const VOTES_TABLE = process.env.VOTES_TABLE!;
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;
const WEBSOCKET_URL = process.env.WEBSOCKET_URL!;

/**
 * Get the WebSocket API management endpoint from WEBSOCKET_URL.
 * WEBSOCKET_URL format: wss://{apiId}.execute-api.{region}.amazonaws.com/{stage}
 * Convert to: https://{apiId}.execute-api.{region}.amazonaws.com/{stage}
 * If custom domain is used, we still need the execute-api endpoint.
 * For simplicity, assume WEBSOCKET_URL is the execute-api URL.
 */
function getWebSocketApiEndpoint(): string {
  if (!WEBSOCKET_URL) {
    throw new Error('WEBSOCKET_URL environment variable is required');
  }
  // Replace wss:// with https://
  return WEBSOCKET_URL.replace('wss://', 'https://');
}

/**
 * Broadcast a roundUpdate message to all participants in a room.
 */
async function broadcastRoundRevealed(
  roomId: string,
  roundId: string,
  round: Round,
  votes: Vote[],
  participants: Participant[]
): Promise<void> {
  const endpoint = getWebSocketApiEndpoint();
  const apiGatewayClient = new ApiGatewayManagementApiClient({ endpoint });

  const message: WebSocketMessage = {
    type: 'roundUpdate',
    payload: { round, votes },
  };

  const activeParticipants = participants.filter(
    (p) => p.connectionId && p.connectionId !== 'REST'
  );

  console.log(`Broadcasting roundUpdate to ${activeParticipants.length} active connections`);

  const promises = activeParticipants.map(async (participant) => {
    try {
      await apiGatewayClient.send(
        new PostToConnectionCommand({
          ConnectionId: participant.connectionId,
          Data: JSON.stringify(message),
        })
      );
      console.log(`Successfully sent roundUpdate to ${participant.connectionId}`);
    } catch (error) {
      console.warn(`Failed to send message to connection ${participant.connectionId}:`, error);
      // If the connection is gone (410) or forbidden (403), clean up the stale connection ID
      const isStaleConnection =
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 410 ||
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 403;

      if (
        isStaleConnection &&
        participant.connectionId &&
        participant.roomId &&
        participant.participantId
      ) {
        try {
          // Remove connectionId from the participant record
          await docClient.send(
            new UpdateCommand({
              TableName: PARTICIPANTS_TABLE,
              Key: {
                roomId: participant.roomId,
                participantId: participant.participantId,
              },
              UpdateExpression: 'REMOVE connectionId SET lastSeenAt = :now',
              ExpressionAttributeValues: {
                ':now': new Date().toISOString(),
              },
            })
          );
          console.log(
            `Cleaned up stale connection ${participant.connectionId} for participant ${participant.participantId}`
          );
          // Invalidate participant cache since participant connection changed
          cacheManager.invalidateParticipants(participant.roomId);
        } catch (cleanupError) {
          console.error('Failed to clean up stale connection:', cleanupError);
        }
      }
    }
  });

  await Promise.allSettled(promises);
}

/**
 * Scheduled Lambda to reveal rounds where scheduledRevealAt has passed.
 * Runs every minute via EventBridge rule.
 */
export const handler = async (): Promise<void> => {
  console.log('Scheduled auto-reveal handler started');
  const now = new Date().toISOString();

  // Validate required environment variables
  if (!WEBSOCKET_URL) {
    throw new Error('WEBSOCKET_URL environment variable is required');
  }

  try {
    // Scan for rounds where scheduledRevealAt <= now and isRevealed = false
    // Note: Scan is acceptable because number of active rounds is small.
    // In production, consider adding a GSI on scheduledRevealAt for efficiency.
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: ROUNDS_TABLE,
        FilterExpression:
          'isRevealed = :false AND attribute_exists(scheduledRevealAt) AND scheduledRevealAt <= :now',
        ExpressionAttributeValues: {
          ':false': false,
          ':now': now,
        },
        Limit: 100, // safety limit
      })
    );

    const rounds = scanResult.Items || [];
    console.log(`Found ${rounds.length} rounds pending auto-reveal`);

    for (const roundItem of rounds) {
      const roomId = roundItem.roomId;
      const roundId = roundItem.roundId || roundItem.id;
      console.log(`Processing auto-reveal for round ${roundId} in room ${roomId}`);

      // Update round as revealed
      await docClient.send(
        new UpdateCommand({
          TableName: ROUNDS_TABLE,
          Key: { roomId, roundId },
          UpdateExpression: 'SET isRevealed = :true, revealedAt = :now REMOVE scheduledRevealAt',
          ExpressionAttributeValues: {
            ':true': true,
            ':now': now,
          },
        })
      );

      // Invalidate cache
      cacheManager.invalidateActiveRound(roomId);

      // Fetch votes for this round
      const votesResult = await docClient.send(
        new QueryCommand({
          TableName: VOTES_TABLE,
          KeyConditionExpression: 'roundId = :roundId',
          ExpressionAttributeValues: {
            ':roundId': roundId,
          },
        })
      );
      const votes = votesResult.Items || [];

      // Fetch participants to broadcast (need connectionIds)
      const participantsResult = await docClient.send(
        new QueryCommand({
          TableName: PARTICIPANTS_TABLE,
          KeyConditionExpression: 'roomId = :roomId',
          ExpressionAttributeValues: {
            ':roomId': roomId,
          },
        })
      );
      const participants = participantsResult.Items || [];

      // Create Round object for broadcasting
      const roundData: Round = {
        id: roundId,
        roomId,
        title: roundItem.title,
        description: roundItem.description,
        startedAt: roundItem.startedAt,
        revealedAt: now,
        isRevealed: true,
        scheduledRevealAt: undefined,
      };

      // Broadcast round update to all participants
      await broadcastRoundRevealed(roomId, roundId, roundData, votes, participants);

      console.log(`Round ${roundId} auto-revealed via scheduled Lambda and broadcasted`);
    }

    console.log('Scheduled auto-reveal handler completed');
  } catch (error) {
    console.error('Scheduled auto-reveal error:', error);
    throw error;
  }
};
