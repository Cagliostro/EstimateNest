import { describe, it, expect, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/health.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

describe('health handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    // Set environment variable for health check
    process.env.ENVIRONMENT = 'test';

    mockEvent = {
      headers: { origin: 'http://localhost:5173' },
      path: '/health',
      httpMethod: 'GET',
    };
  });

  it('should return healthy status with CORS headers', async () => {
    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:5173',
    });

    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
    expect(body.timestamp).toBeDefined();
    expect(body.environment).toBe('test');
  });

  it('should handle missing origin header', async () => {
    const event = { ...mockEvent, headers: {} };
    const response = await handler(event as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');

    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
  });

  it('should handle undefined environment variable', async () => {
    delete process.env.ENVIRONMENT;
    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.environment).toBe('unknown');
  });
});
