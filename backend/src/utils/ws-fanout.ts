import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  ApiGatewayManagementApiServiceException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { WebSocketMessage, Participant } from '@estimatenest/shared';
import { getDocClient } from './dynamodb';
import { createLogger } from './logger';
import { getCacheManager } from './cache';

const docClient = getDocClient();
const cacheManager = getCacheManager();

// A 410 also hits connections whose $connect is still completing the
// handshake: the row's connectionId is written before the handler returns
// and a concurrent fan-out can race that window. Stripping the mapping then
// orphans the participant (connected, but invisible). Mappings younger than
// this grace are left alone — a genuinely dead connection is cleaned by its
// own $disconnect.
const CONNECTION_CLEANUP_GRACE_MS = 15_000;

/**
 * Resolve the WebSocket management endpoint (https://{apiId}.execute-api.{region}.amazonaws.com/{stage})
 * from the Lambda event. Falls back to AWS_REGION when domainName is not an
 * execute-api URL (e.g. custom domain).
 */
export function resolveManagementEndpoint(ctx: {
  domainName?: string;
  stage?: string;
  apiId?: string;
}): string {
  const { domainName = '', stage, apiId } = ctx;
  let region = process.env.AWS_REGION || 'eu-central-1';
  if (domainName.includes('.execute-api.')) {
    const match = domainName.match(/execute-api\.([a-z0-9-]+)\.amazonaws\.com/);
    if (match) region = match[1];
  }
  return `https://${apiId}.execute-api.${region}.amazonaws.com/${stage}`;
}

// The client is stateless and safe to share per endpoint across invocations
// on the same warm Lambda instance.
const clientsByEndpoint = new Map<string, ApiGatewayManagementApiClient>();

export function getManagementClient(endpoint: string): ApiGatewayManagementApiClient {
  let client = clientsByEndpoint.get(endpoint);
  if (!client) {
    client = new ApiGatewayManagementApiClient({ endpoint });
    clientsByEndpoint.set(endpoint, client);
  }
  return client;
}

export interface SendFanOutOptions {
  message: WebSocketMessage;
  participants: Participant[];
  client: ApiGatewayManagementApiClient;
  excludeConnectionId?: string;
}

/**
 * Fan out a message to all connected participants. Connections that respond
 * with 410 (gone) or 403 are treated as stale: their connectionId mapping is
 * removed under the connect-grace guard, the room's connection count is
 * decremented to compensate the no-op'ing $disconnect, and the participant
 * cache is invalidated. Returns the participants whose mapping was removed —
 * whoever removes a mapping must inform the room (roster refresh), or the
 * remaining clients keep a ghost.
 */
export async function sendFanOut(options: SendFanOutOptions): Promise<Participant[]> {
  const logger = createLogger();
  const { message, participants, client, excludeConnectionId } = options;

  const activeParticipants = participants.filter(
    (p) => p.connectionId && p.connectionId !== 'REST' && p.connectionId !== excludeConnectionId
  );
  const cleanedParticipants: Participant[] = [];

  // Send message to each active WebSocket connection
  const promises = activeParticipants.map(async (participant) => {
    try {
      await client.send(
        new PostToConnectionCommand({
          ConnectionId: participant.connectionId,
          Data: JSON.stringify(message),
        })
      );
    } catch (error) {
      logger.warn('Failed to send message to connection', { error });

      // If the connection is gone (410) or forbidden (403), clean up the stale connection ID
      const isStaleConnection =
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 410 ||
        (error as ApiGatewayManagementApiServiceException).$metadata?.httpStatusCode === 403;

      if (
        isStaleConnection &&
        participant.connectionId &&
        participant.roomId &&
        participant.id
      ) {
        try {
          // Remove connectionId only if it still maps the dead connection and
          // the mapping is older than the connect grace: a racing reconnect
          // may have mapped this row to a live connection (mapping-nuke race)
          // and a fresh mapping may belong to a connection whose handshake is
          // still completing (orphaning race) — both must stay.
          await docClient.send(
            new UpdateCommand({
              TableName: process.env.PARTICIPANTS_TABLE!,
              Key: {
                roomId: participant.roomId,
                participantId: participant.id,
              },
              UpdateExpression: 'REMOVE connectionId SET lastSeenAt = :now',
              ConditionExpression: 'connectionId = :cid AND lastSeenAt < :graceCutoff',
              ExpressionAttributeValues: {
                ':cid': participant.connectionId,
                ':now': new Date().toISOString(),
                ':graceCutoff': new Date(
                  Date.now() - CONNECTION_CLEANUP_GRACE_MS
                ).toISOString(),
              },
            })
          );
          logger.info('Cleaned up stale connection', { roomId: participant.roomId });
          // Whoever removes a connection mapping balances the room's
          // connection count: the pending $disconnect for this dead
          // connection no-ops against the now-empty mapping (see
          // websocket-disconnect), so the count must be balanced here.
          await docClient.send(
            new UpdateCommand({
              TableName: process.env.ROOMS_TABLE!,
              Key: { id: participant.roomId, sk: 'META' },
              UpdateExpression: 'ADD connectionCount :dec',
              ExpressionAttributeValues: { ':dec': -1 },
            })
          );
          // Invalidate participant cache since participant connection changed
          cacheManager.invalidateParticipants(participant.roomId);
          cleanedParticipants.push(participant);
        } catch (cleanupError) {
          if ((cleanupError as Error).name === 'ConditionalCheckFailedException') {
            // The row maps a newer live connection (mapping-nuke guard) or the
            // mapping is younger than the connect grace (handshake race) — in
            // both cases the mapping must be left alone.
            logger.info('Skipped stale-connection cleanup', {
              roomId: participant.roomId,
            });
          } else {
            logger.error('Failed to clean up stale connection', { error: cleanupError });
          }
        }
      }
    }
  });

  await Promise.allSettled(promises);

  return cleanedParticipants;
}
