import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const PARTICIPANTS_TABLE = process.env.PARTICIPANTS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { connectionId } = event.requestContext;
  const { roomId, participantId } = event.queryStringParameters || {};

  if (!roomId || !participantId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing roomId or participantId' }),
    };
  }

  try {
    // Update participant with WebSocket connection ID
    await docClient.send(new UpdateCommand({
      TableName: PARTICIPANTS_TABLE,
      Key: { roomId, participantId },
      UpdateExpression: 'SET connectionId = :cid, lastSeenAt = :now',
      ExpressionAttributeValues: {
        ':cid': connectionId,
        ':now': new Date().toISOString(),
      },
    }));

    // Notify others in the room about new participant (optional)
    // For now, just return success
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Connected' }),
    };
  } catch (error) {
    console.error('WebSocket connect error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};