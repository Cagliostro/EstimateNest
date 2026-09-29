import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/websocket-connect.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB, mockCacheManager, mockQueryCommand, mockUpdateCommand } = vi.hoisted(() => {
  return {
    mockDynamoDB: {
      send: vi.fn(),
    },
    mockCacheManager: {
      getRoomWithCache: vi.fn(),
      getParticipantsWithCache: vi.fn(),
      invalidateParticipants: vi.fn(),
    },
    mockQueryCommand: vi.fn(),
    mockUpdateCommand: vi.fn(),
  };
});

// Mock the DynamoDB DocumentClient - hoisted before imports. GetCommand must
// exist: the handler resolves a pending moderator vacancy (moderator.ts reads
// the room META item) right after the participant update.
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => mockDynamoDB),
  },
  // Real classes record construction so the tests can assert on the built
  // command inputs; mockDynamoDB.send stays the stubbed transport.
  QueryCommand: class {
    input: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      mockQueryCommand(params);
      this.input = params;
    }
  },
  GetCommand: vi.fn(),
  UpdateCommand: class {
    input: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      mockUpdateCommand(params);
      this.input = params;
    }
  },
  TransactWriteCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
}));

// Mock the broadcast utilities
vi.mock('../../src/utils/broadcast', () => ({
  broadcastToRoom: vi.fn(() => Promise.resolve()),
}));

// Mock the cache module
vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

describe('websocket-connect handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock send function completely
    mockDynamoDB.send.mockReset();
    // Default mock that throws if called unexpectedly
    mockDynamoDB.send.mockImplementation(() => {
      throw new Error('Unexpected call to DynamoDB - test should mock this call');
    });

    // Reset cache mocks
    mockCacheManager.getRoomWithCache.mockReset();
    mockCacheManager.getParticipantsWithCache.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();
    // Default mock that throws if called unexpectedly
    mockCacheManager.getRoomWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getRoomWithCache - test should mock this call');
    });
    mockCacheManager.getParticipantsWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getParticipantsWithCache - test should mock this call');
    });

    // Set environment variables required by the handler
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';

    mockEvent = {
      requestContext: {
        connectionId: 'test-connection-id',
        domainName: 'test.execute-api.us-east-1.amazonaws.com',
        stage: 'test',
      },
      queryStringParameters: {
        roomId: '11111111-2222-4333-8444-555555555555',
        participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    };
  });

  it('should successfully connect WebSocket and update participant', async () => {
    // Mock room fetch (getRoomWithCache) - with maxParticipants
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: '11111111-2222-4333-8444-555555555555',
      maxParticipants: 100,
    });

    // Mock connection limit check (QueryCommand for count) - under limit
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 50, // under 100 limit
    });

    // Mock participant update (UpdateCommand)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock moderator vacancy read (room META — no pending vacancy)
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {},
    });

    // Mock participants cache
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        name: 'Test User',
        connectionId: 'test-connection-id',
        isModerator: false,
      },
      {
        id: 'bbbbbbbb-cccc-dddd-9eee-ffffffffffff',
        name: 'Another User',
        connectionId: 'other-connection-id',
        isModerator: true,
      },
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('connected');
    expect(body.payload.message).toBe('Connected');
    // Verify cache invalidation was called
    expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555'
    );
    // Exactly three DynamoDB calls: count increment, participant update,
    // moderator vacancy read.
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(3);
  });

  it('should reject connection when room connection limit exceeded', async () => {
    // Mock room fetch (getRoomWithCache) - with maxParticipants
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: '11111111-2222-4333-8444-555555555555',
      maxParticipants: 100,
    });

    // Guarded increment fails (ConditionalCheckFailedException) - over limit
    const conditionalError = new Error('Conditional check failed');
    (conditionalError as Error & { name: string }).name = 'ConditionalCheckFailedException';
    mockDynamoDB.send.mockRejectedValueOnce(conditionalError);
    // Measurement confirms the limit is real (ADR-11): no renormalization.
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 100 });

    const response = await handler(mockEvent as APIGatewayProxyEvent);
    console.log('Response:', response.statusCode, response.body);

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Connection limit exceeded (max 100 connections per room)');
    // Increment attempt + measurement only — no renormalize, no retry.
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(2);
  });

  it('should return 400 for invalid roomId format', async () => {
    // Invalid roomId (not a UUID)
    mockEvent.queryStringParameters = {
      roomId: 'invalid-room-id',
      participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Invalid roomId or participantId format');
  });

  it('should return 400 for invalid participantId format', async () => {
    // Invalid participantId (not a UUID)
    mockEvent.queryStringParameters = {
      roomId: '11111111-2222-4333-8444-555555555555',
      participantId: 'invalid-participant-id',
    };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Invalid roomId or participantId format');
  });

  it('should return 400 for missing roomId or participantId', async () => {
    // Missing roomId
    mockEvent.queryStringParameters = {
      participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Invalid roomId or participantId format');
  });

  it('promotes the joining participant after a solo moderator leave (BK-011)', async () => {
    // The moderator was the last live connection and left ($disconnect now
    // always marks a vacancy). A later joiner connects after the 60 s grace —
    // the connect must promote them and demote the dormant moderator row.
    const roomId = '11111111-2222-4333-8444-555555555555';
    const participantId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const moderatorId = 'bbbbbbbb-cccc-dddd-9eee-ffffffffffff';
    const connectionId = 'test-connection-id';

    // Mock room fetch (getRoomWithCache) - with maxParticipants
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      maxParticipants: 100,
    });

    // Mock connection limit check (UpdateCommand) - under limit
    mockDynamoDB.send.mockResolvedValueOnce({});
    // Mock participant update (UpdateCommand - set connectionId)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock moderator vacancy read (GetCommand on room META): vacancy set when
    // the moderator left as the last live participant, long past the grace.
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: { moderatorVacantAt: new Date(Date.now() - 120_000).toISOString() },
    });

    // Participants read inside handleModeratorVacancy: only the dormant
    // moderator row (connectionId removed by its $disconnect) and the joiner.
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      { id: moderatorId, roomId, name: 'Old Moderator', isModerator: true },
      {
        id: participantId,
        roomId,
        name: 'Joiner',
        connectionId,
        isModerator: false,
        lastSeenAt: new Date().toISOString(),
      },
    ]);
    // Promotion transaction succeeds
    mockDynamoDB.send.mockResolvedValueOnce({});
    // Roster read for the connect broadcast
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      { id: moderatorId, roomId, name: 'Old Moderator', isModerator: false },
      {
        id: participantId,
        roomId,
        name: 'Joiner',
        connectionId,
        isModerator: true,
        lastSeenAt: new Date().toISOString(),
      },
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('connected');

    // Exactly one promotion transaction: promote the joining participant,
    // demote the dormant moderator row, clear the vacancy.
    const transactInputs = mockDynamoDB.send.mock.calls
      .map((call) => (call[0] as { input?: { TransactItems?: unknown[] } }).input)
      .filter((input) => input && Array.isArray(input.TransactItems));
    expect(transactInputs).toHaveLength(1);
    const transactItems = transactInputs[0].TransactItems as Array<{
      Update?: {
        Key?: Record<string, string>;
        UpdateExpression?: string;
        ConditionExpression?: string;
      };
    }>;
    const updates = transactItems.map((item) => item.Update).filter(Boolean);
    expect(updates).toContainEqual(
      expect.objectContaining({
        Key: { roomId, participantId },
        UpdateExpression: 'SET isModerator = :true',
        ConditionExpression: 'attribute_exists(connectionId)',
      })
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        Key: { roomId, participantId: moderatorId },
        UpdateExpression: 'SET isModerator = :false',
      })
    );
    const vacancyClear = updates.find((u) =>
      u?.UpdateExpression?.startsWith('REMOVE moderatorVacantAt')
    );
    expect(vacancyClear).toBeDefined();

    // The fresh roster (with the promoted joiner) is broadcast
    const { broadcastToRoom } = await import('../../src/utils/broadcast.js');
    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      expect.anything(),
      roomId,
      expect.objectContaining({
        type: 'participantList',
        payload: {
          participants: expect.arrayContaining([
            expect.objectContaining({ id: participantId, isModerator: true }),
          ]),
        },
      }),
      connectionId // exclude the newly connected participant
    );
  });

  it('should handle DynamoDB update error and return 500', async () => {
    // Mock room fetch (getRoomWithCache)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: '11111111-2222-4333-8444-555555555555',
      maxParticipants: 100,
    });

    // Mock connection limit check
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 50,
    });

    // Mock participant update to throw error
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Internal server error');
  });

  it('logs the rejection with the raw query values on invalid params (ADR-10)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockEvent.queryStringParameters = {
      roomId: 'invalid-room-id',
      participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const logCall = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes('WebSocket connect rejected: invalid params')
    );
    expect(logCall).toBeDefined();
    expect(JSON.parse(String(logCall![0]))).toMatchObject({
      connectionId: 'test-connection-id',
      roomId: 'invalid-room-id',
      participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    warnSpy.mockRestore();
  });

  it('logs the rejection when the room is missing (ADR-10)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce(null);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(404);
    const logCall = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes('WebSocket connect rejected: room not found')
    );
    expect(logCall).toBeDefined();
    expect(JSON.parse(String(logCall![0]))).toMatchObject({
      connectionId: 'test-connection-id',
      roomId: '11111111-2222-4333-8444-555555555555',
      participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    warnSpy.mockRestore();
  });

  it('renormalizes a drifted connectionCount and retries the increment (ADR-11)', async () => {
    const roomId = '11111111-2222-4333-8444-555555555555';
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({ id: roomId, maxParticipants: 100 });

    // 1) Guarded increment fails: the drifted counter reads as full. The
    //    condition failure carries the old room item (raw, not unmarshalled).
    const ccf = new Error('Conditional check failed');
    ccf.name = 'ConditionalCheckFailedException';
    (ccf as unknown as { Item: unknown }).Item = { connectionCount: { N: '100' } };
    mockDynamoDB.send.mockRejectedValueOnce(ccf);
    // 2) Measurement: only two live WebSocket mappings remain.
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 2 });
    // 3) Renormalize (SET), 4) retried increment, 5) participant update,
    // 6) moderator vacancy read.
    mockDynamoDB.send.mockResolvedValueOnce({});
    mockDynamoDB.send.mockResolvedValueOnce({});
    mockDynamoDB.send.mockResolvedValueOnce({});
    mockDynamoDB.send.mockResolvedValueOnce({ Item: {} });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    // The drift log shows old -> new counter value (ADR-11 / AK-18.3).
    const driftLog = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes('Renormalized drifted connectionCount')
    );
    expect(driftLog).toBeDefined();
    expect(JSON.parse(String(driftLog![0]))).toMatchObject({
      previousConnectionCount: 100,
      connectionCount: 2,
    });
    warnSpy.mockRestore();
    // The measurement is a consistent query counting only real mappings.
    const queryCall = mockQueryCommand.mock.calls.find(
      (call) => (call[0] as { ConsistentRead?: boolean }).ConsistentRead === true
    );
    expect(queryCall).toBeDefined();
    expect(queryCall![0]).toMatchObject({
      KeyConditionExpression: 'roomId = :roomId',
      FilterExpression: 'connectionId <> :rest',
      ConsistentRead: true,
    });
    // The guarded increment asks for the pre-increment item so the drift is
    // measurable from the log.
    const incrementCall = mockUpdateCommand.mock.calls.find((call) =>
      (call[0] as { UpdateExpression?: string }).UpdateExpression?.startsWith(
        'ADD connectionCount'
      )
    );
    expect(incrementCall).toBeDefined();
    expect(incrementCall![0]).toMatchObject({
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    // The counter is renormalized before the retried increment.
    const setCall = mockUpdateCommand.mock.calls.find((call) =>
      (call[0] as { UpdateExpression?: string }).UpdateExpression?.startsWith(
        'SET connectionCount'
      )
    );
    expect(setCall).toBeDefined();
    expect(setCall![0]).toMatchObject({ ExpressionAttributeValues: { ':measured': 2 } });
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(6);
  });

  it('rejects with 429 when the measured count confirms the limit (ADR-11)', async () => {
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: '11111111-2222-4333-8444-555555555555',
      maxParticipants: 100,
    });
    const ccf = new Error('Conditional check failed');
    ccf.name = 'ConditionalCheckFailedException';
    mockDynamoDB.send.mockRejectedValueOnce(ccf);
    // Measurement confirms 100 live connections — genuinely full.
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 100 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(429);
    // No renormalization, no retried increment: increment + measurement only.
    expect(mockDynamoDB.send).toHaveBeenCalledTimes(2);
    expect(
      mockUpdateCommand.mock.calls.some((call) =>
        (call[0] as { UpdateExpression?: string }).UpdateExpression?.startsWith(
          'SET connectionCount'
        )
      )
    ).toBe(false);
    const logCall = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes('WebSocket connect rejected: connection limit reached')
    );
    expect(logCall).toBeDefined();
    expect(JSON.parse(String(logCall![0]))).toMatchObject({
      connectionCount: 100,
      maxParticipants: 100,
    });
    warnSpy.mockRestore();
  });
});
