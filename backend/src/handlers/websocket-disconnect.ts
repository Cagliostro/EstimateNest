import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { broadcastToRoom } from '../utils/broadcast';
import { getCacheManager } from '../utils/cache';

const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(client);
const cacheManager = getCacheManager();
const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { connectionId } = event.requestContext;

  try {
    // Find participant by connectionId using GSI
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
      // No participant found with this connectionId, just return success
      return {
        statusCode: 200,
        body: JSON.stringify({ type: 'disconnected', payload: { message: 'Disconnected' } }),
      };
    }

    const { roomId, participantId } = participant;

    // Clear connectionId from participant record
    await docClient.send(
      new UpdateCommand({
        TableName: PARTICIPANTS_TABLE,
        Key: { roomId, participantId },
        UpdateExpression: 'REMOVE connectionId SET lastSeenAt = :now',
        ExpressionAttributeValues: {
          ':now': new Date().toISOString(),
        },
      })
    );
    // Invalidate participant cache since connectionId removed
    cacheManager.invalidateParticipants(roomId);

    // Check if disconnected participant is moderator and reassign if needed
    const isDisconnectedModerator = participant.isModerator;
    if (isDisconnectedModerator) {
      // Fetch all participants in the room (cached, invalidated just above)
      const allParticipants = await cacheManager.getParticipantsWithCache(roomId);

      // Find other connected participants (excluding the disconnected one and REST connections)
      const otherConnectedParticipants = allParticipants.filter(
        (p) => p.id !== participantId && p.connectionId && p.connectionId !== 'REST'
      );

      if (otherConnectedParticipants.length > 0) {
        // Pick the oldest connected participant by joinedAt
        const newModerator = otherConnectedParticipants.reduce((oldest, current) =>
          new Date(oldest.joinedAt) < new Date(current.joinedAt) ? oldest : current
        );

        // Update new moderator
        await docClient.send(
          new UpdateCommand({
            TableName: PARTICIPANTS_TABLE,
            Key: { roomId, participantId: newModerator.id },
            UpdateExpression: 'SET isModerator = :true',
            ExpressionAttributeValues: {
              ':true': true,
            },
          })
        );

        // Update disconnected participant to no longer be moderator
        await docClient.send(
          new UpdateCommand({
            TableName: PARTICIPANTS_TABLE,
            Key: { roomId, participantId },
            UpdateExpression: 'SET isModerator = :false',
            ExpressionAttributeValues: {
              ':false': false,
            },
          })
        );

        // Invalidate cache again since moderator status changed
        cacheManager.invalidateParticipants(roomId);
        console.log(
          `Moderator reassigned from ${participantId} to ${newModerator.id} in room ${roomId}`
        );
      } else {
        // No other connected participants - keep disconnected participant as moderator
        // They may reconnect later
        console.log(
          `Moderator ${participantId} disconnected but no other connected participants to reassign to`
        );
      }
    }

    // Fetch all participants in the room (cached, possibly invalidated)
    const participants = await cacheManager.getParticipantsWithCache(roomId);

    // Broadcast updated participant list to everyone in the room (fire-and-forget)
    broadcastToRoom(
      event,
      roomId,
      {
        type: 'participantList',
        payload: { participants },
      },
      connectionId
    ).catch((broadcastError) => {
      console.warn('Broadcast participantList failed:', broadcastError);
    });

    // Also send a leave notification for clients that track individual leaves (fire-and-forget)
    broadcastToRoom(
      event,
      roomId,
      {
        type: 'leave',
        payload: { participantId },
      },
      connectionId
    ).catch((broadcastError) => {
      console.warn('Broadcast leave failed:', broadcastError);
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ type: 'disconnected', payload: { message: 'Disconnected' } }),
    };
  } catch (error) {
    console.error('WebSocket disconnect error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ type: 'error', payload: { error: 'Internal server error' } }),
    };
  }
};
