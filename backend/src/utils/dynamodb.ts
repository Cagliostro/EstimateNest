import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import AWSXRay from 'aws-xray-sdk';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let client: DynamoDBClient | null = null;
let docClient: DynamoDBDocumentClient | null = null;

export function getDynamoDBClient(): DynamoDBClient {
  if (!client) {
    client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
  }
  return client;
}

export function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(getDynamoDBClient());
  }
  return docClient;
}
