import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  ApiGatewayManagementApiServiceException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { WebSocketMessage } from '@estimatenest/shared';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

/**
 * Broadcast a WebSocket message to all participants in a room.
 * @param event The Lambda event (to extract domainName and stage)
 * @param roomId The room ID
 * @param message The message to broadcast
 * @param excludeConnectionId Optional connection ID to exclude (e.g., sender)
 */
export async function broadcastToRoom(
  event: APIGatewayProxyEvent,
  roomId: string,
  message: WebSocketMessage,
  excludeConnectionId?: string
): Promise<void> {
  const { domainName, stage, apiId } = event.requestContext;
  // Determine region from domainName (if execute-api domain) or from environment
  let region = process.env.AWS_REGION || 'eu-central-1';
  if (domainName.includes('.execute-api.')) {
    const match = domainName.match(/execute-api\.([a-z0-9-]+)\.amazonaws\.com/);
    if (match) region = match[1];
  }
  const endpoint = `https://${apiId}.execute-api.${region}.amazonaws.com/${stage}`;
  console.log(
    `Broadcast endpoint: domainName=${domainName}, stage=${stage}, apiId=${apiId}, region=${region}, endpoint=${endpoint}, room: ${roomId}, exclude: ${excludeConnectionId}`
  );
  const apiGatewayClient = new ApiGatewayManagementApiClient({ endpoint });

  // Fetch all participants in the room
  const participantsResult = await docClient.send(
    new QueryCommand({
      TableName: process.env.PARTICIPANTS_TABLE!,
      KeyConditionExpression: 'roomId = :roomId',
      ExpressionAttributeValues: {
        ':roomId': roomId,
      },
    })
  );

  const participants = participantsResult.Items || [];
  if (!message.type) {
    console.error('⚠️ Broadcast message missing type field! Message:', JSON.stringify(message));
  }
  console.log(
    `Broadcasting message type: ${message.type}`,
    message.type === 'roundUpdate'
      ? `roundId: ${(message.payload as { round?: { id: string } }).round?.id}`
      : ''
  );
  console.log(`Broadcast: ${participants.length} participants total, room ${roomId}`);
  const activeParticipants = participants.filter(
    (p) => p.connectionId && p.connectionId !== 'REST' && p.connectionId !== excludeConnectionId
  );
  console.log(`Broadcast: ${activeParticipants.length} active connections to send to`);
  console.log(
    'Active participants:',
    activeParticipants.map((p) => ({
      participantId: p.participantId,
      connectionId: p.connectionId,
      name: p.name,
    }))
  );
  console.log(
    'All participants:',
    participants.map((p) => ({
      participantId: p.participantId,
      connectionId: p.connectionId,
      name: p.name,
    }))
  );

  // Send message to each active WebSocket connection
  const promises = activeParticipants.map(async (participant) => {
    console.log(
      `Attempting to send to connection ${participant.connectionId}, message type: ${message.type}`
    );
    try {
      await apiGatewayClient.send(
        new PostToConnectionCommand({
          ConnectionId: participant.connectionId,
          Data: JSON.stringify(message),
        })
      );
      console.log(`Successfully sent ${message.type} to ${participant.connectionId}`);
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
              TableName: process.env.PARTICIPANTS_TABLE!,
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
        } catch (cleanupError) {
          console.error('Failed to clean up stale connection:', cleanupError);
        }
      }
    }
  });

  await Promise.allSettled(promises);
}

/**
 * Send a WebSocket message to a specific connection.
 * @param event The Lambda event (to extract domainName and stage)
 * @param connectionId The target connection ID
 * @param message The message to send
 */
export async function sendToConnection(
  event: APIGatewayProxyEvent,
  connectionId: string,
  message: WebSocketMessage
): Promise<void> {
  const { domainName, stage, apiId } = event.requestContext;
  // Determine region from domainName (if execute-api domain) or from environment
  let region = process.env.AWS_REGION || 'eu-central-1';
  if (domainName.includes('.execute-api.')) {
    const match = domainName.match(/execute-api\.([a-z0-9-]+)\.amazonaws\.com/);
    if (match) region = match[1];
  }
  const endpoint = `https://${apiId}.execute-api.${region}.amazonaws.com/${stage}`;
  console.log(
    `SendToConnection constructing endpoint: domainName=${domainName}, stage=${stage}, apiId=${apiId}, region=${region}, endpoint=${endpoint}`
  );
  const apiGatewayClient = new ApiGatewayManagementApiClient({ endpoint });
  console.log(`SendToConnection endpoint: ${endpoint}, connection: ${connectionId}`);
  if (!message.type) {
    console.error(
      '⚠️ SendToConnection message missing type field! Message:',
      JSON.stringify(message)
    );
  }

  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await apiGatewayClient.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify(message),
        })
      );
      console.log(`Successfully sent to ${connectionId} (attempt ${attempt})`);
      return;
    } catch (error) {
      lastError = error;
      const isGoneException =
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 410;
      console.warn(`Attempt ${attempt} failed to send to ${connectionId}:`, error);

      if (isGoneException && attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const delayMs = 100 * Math.pow(2, attempt - 1);
        console.log(`Connection ${connectionId} gone, retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      // Not a gone exception or no more retries
      break;
    }
  }

  console.warn(
    `Failed to send message to connection ${connectionId} after ${maxRetries} attempts:`,
    lastError
  );
  // Re-throw the last error so the caller can handle it
  throw lastError;
}
