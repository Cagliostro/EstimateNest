import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/websocket-disconnect.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB, mockCacheManager } = vi.hoisted(() => {
  return {
    mockDynamoDB: {
      send: vi.fn(),
    },
    mockCacheManager: {
      getParticipantsWithCache: vi.fn(),
      invalidateParticipants: vi.fn(),
    },
  };
});

// Mock the DynamoDB DocumentClient - hoisted before imports. Command
// constructors capture their input on the instance so tests can assert on
// UpdateExpressions (e.g. the mapping-nuke ConditionExpression).
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => mockDynamoDB),
  },
  QueryCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
  GetCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
  UpdateCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
  TransactWriteCommand: vi.fn(),
  ConditionalCheckFailedException: class extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'ConditionalCheckFailedException';
    }
  },
}));

// Mock the broadcast utilities
vi.mock('../../src/utils/broadcast', () => ({
  broadcastToRoom: vi.fn(() => Promise.resolve()),
}));

// Mock the cache module
vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

const ROOM_ID = '11111111-2222-4333-8444-555555555555';
const PARTICIPANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_ID = 'bbbbbbbb-cccc-dddd-9eee-ffffffffffff';
const CONNECTION_ID = 'test-connection-id';

function liveParticipant(id: string, isModerator: boolean) {
  return { id, roomId: ROOM_ID, name: 'User', connectionId: `conn-${id}`, isModerator };
}

interface UpdateInput {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/** All UpdateCommand inputs passed to send. */
function updateInputs() {
  return mockDynamoDB.send.mock.calls
    .map((call) => (call[0] as { input?: UpdateInput }).input)
    .filter((input) => input && input.UpdateExpression !== undefined);
}

describe('websocket-disconnect handler', () => {
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
    mockCacheManager.getParticipantsWithCache.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();
    // Default mock that throws if called unexpectedly
    mockCacheManager.getParticipantsWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getParticipantsWithCache - test should mock this call');
    });

    // Set environment variables required by the handler
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';
    process.env.ROOMS_TABLE = 'test-rooms-table';

    mockEvent = {
      requestContext: {
        connectionId: CONNECTION_ID,
        domainName: 'test.execute-api.us-east-1.amazonaws.com',
        stage: 'test',
      },
    };
  });

  function mockRowByConnection() {
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          roomId: ROOM_ID,
          participantId: PARTICIPANT_ID,
          name: 'Test User',
          isModerator: false,
          connectionId: CONNECTION_ID,
        },
      ],
    });
  }

  function mockRowRead(item?: Record<string, unknown>) {
    mockDynamoDB.send.mockResolvedValueOnce({ Item: item });
  }

  it('should remove the connection mapping and decrement the count on disconnect', async () => {
    mockRowByConnection();
    mockRowRead({
      roomId: ROOM_ID,
      participantId: PARTICIPANT_ID,
      isModerator: false,
      connectionId: CONNECTION_ID,
    });
    mockDynamoDB.send.mockResolvedValueOnce({}); // conditional REMOVE connectionId
    mockDynamoDB.send.mockResolvedValueOnce({}); // decrement connectionCount

    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      liveParticipant(OTHER_ID, false),
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('disconnected');
    expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(ROOM_ID);

    // Mapping-nuke guard: the row's connectionId is only removed when it still
    // maps THIS connection.
    const removeInput = updateInputs().find((input) =>
      input.UpdateExpression?.startsWith('REMOVE connectionId')
    );
    expect(removeInput).toBeDefined();
    expect(removeInput!.ConditionExpression).toBe(
      'connectionId = :cid AND attribute_exists(connectionId)'
    );

    // Count balance: exactly one decrement after a successful mapping removal.
    const decrements = updateInputs().filter((input) =>
      input.UpdateExpression?.startsWith('ADD connectionCount')
    );
    expect(decrements).toHaveLength(1);
  });

  it('should treat a stale disconnect as successful without touching the live row', async () => {
    mockRowByConnection();
    // The consistent read is the authority: a racing reconnect already
    // replaced the mapping with a newer live connection.
    mockRowRead({
      roomId: ROOM_ID,
      participantId: PARTICIPANT_ID,
      isModerator: false,
      connectionId: 'newer-live-connection',
    });
    mockDynamoDB.send.mockResolvedValueOnce({}); // count-balance decrement

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    // No invalidation, no broadcast — the row maps a live connection.
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
    const { broadcastToRoom } = await import('../../src/utils/broadcast.js');
    expect(broadcastToRoom).not.toHaveBeenCalled();

    // Even stale disconnects balance the connection count (each counted
    // $connect receives exactly one disconnect event).
    const decrements = updateInputs().filter((input) =>
      input.UpdateExpression?.startsWith('ADD connectionCount')
    );
    expect(decrements).toHaveLength(1);
  });

  it('should not decrement when the mapping was already removed (redelivery)', async () => {
    mockRowByConnection();
    // Base row without connectionId: the first delivery (or a broadcast
    // cleanup) already removed the mapping — only the eventually-consistent
    // GSI entry still lingers.
    mockRowRead({ roomId: ROOM_ID, participantId: PARTICIPANT_ID, isModerator: false });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
    // Whoever removed the mapping already balanced the count — a decrement
    // here would double it.
    expect(updateInputs()).toHaveLength(0);
  });

  it('should not decrement when the row now maps the REST poller marker', async () => {
    mockRowByConnection();
    // Cleanup removed the WS mapping (and balanced the count), then the
    // participant REST-rejoined (connectionId = 'REST') before the late
    // $disconnect of the old connection arrived.
    mockRowRead({
      roomId: ROOM_ID,
      participantId: PARTICIPANT_ID,
      isModerator: false,
      connectionId: 'REST',
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
    expect(updateInputs()).toHaveLength(0);
  });

  it('should return success when no participant row maps the connection', async () => {
    // GSI returns nothing
    mockDynamoDB.send.mockResolvedValueOnce({ Items: [] });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
    expect(updateInputs()).toHaveLength(0);
  });

  it('should return success when the row expired between queries', async () => {
    mockRowByConnection();
    mockRowRead(undefined); // consistent read finds no row

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
    expect(updateInputs()).toHaveLength(0);
  });

  it('should mark a moderator vacancy when other live connections remain', async () => {
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          roomId: ROOM_ID,
          participantId: PARTICIPANT_ID,
          name: 'Moderator',
          isModerator: true,
          connectionId: CONNECTION_ID,
        },
      ],
    });
    mockRowRead({
      roomId: ROOM_ID,
      participantId: PARTICIPANT_ID,
      isModerator: true,
      connectionId: CONNECTION_ID,
    });
    mockDynamoDB.send.mockResolvedValueOnce({}); // conditional REMOVE connectionId
    mockDynamoDB.send.mockResolvedValueOnce({}); // decrement connectionCount
    mockDynamoDB.send.mockResolvedValueOnce({}); // SET moderatorVacantAt

    // Room still has another live participant (broadcast fetch, called twice:
    // once for the vacancy check, once for the broadcast).
    mockCacheManager.getParticipantsWithCache.mockResolvedValue([
      liveParticipant(OTHER_ID, false),
      liveParticipant(PARTICIPANT_ID, true), // row still exists, mapping removed
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);

    // No immediate reassignment: the role is parked as a vacancy for the
    // ~60 s reconnect grace instead.
    const vacancy = updateInputs().find((input) =>
      input.UpdateExpression?.startsWith('SET moderatorVacantAt')
    );
    expect(vacancy).toBeDefined();
    expect(vacancy!.ExpressionAttributeValues).toBeDefined();

    const { broadcastToRoom } = await import('../../src/utils/broadcast.js');
    expect(broadcastToRoom).toHaveBeenCalled();
  });

  it('should mark a vacancy when the moderator was the last live connection', async () => {
    mockRowByConnection();
    mockRowRead({
      roomId: ROOM_ID,
      participantId: PARTICIPANT_ID,
      isModerator: true,
      connectionId: CONNECTION_ID,
    });
    mockDynamoDB.send.mockResolvedValueOnce({}); // conditional REMOVE connectionId
    mockDynamoDB.send.mockResolvedValueOnce({}); // decrement connectionCount
    mockDynamoDB.send.mockResolvedValueOnce({}); // SET moderatorVacantAt

    // No other live connection remains — only the departed moderator's row.
    mockCacheManager.getParticipantsWithCache.mockResolvedValue([
      { ...liveParticipant(PARTICIPANT_ID, true), connectionId: 'REST' },
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    // Without the vacancy a room whose moderator leaves as the last live
    // connection would stay permanently without a moderator (BK-011): the
    // next join must find a vacancy to resolve after the grace window.
    const vacancy = updateInputs().find((input) =>
      input.UpdateExpression?.startsWith('SET moderatorVacantAt')
    );
    expect(vacancy).toBeDefined();
  });

  it('should broadcast only present participants after the disconnect', async () => {
    mockRowByConnection();
    mockRowRead({
      roomId: ROOM_ID,
      participantId: PARTICIPANT_ID,
      isModerator: false,
      connectionId: CONNECTION_ID,
    });
    mockDynamoDB.send.mockResolvedValueOnce({}); // conditional REMOVE connectionId
    mockDynamoDB.send.mockResolvedValueOnce({}); // decrement connectionCount

    // One live participant, one ghost (stale REST row) — the ghost must not
    // be broadcast.
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      liveParticipant(OTHER_ID, false),
      {
        id: PARTICIPANT_ID,
        roomId: ROOM_ID,
        name: 'Ghost',
        connectionId: 'REST',
        lastSeenAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        isModerator: false,
      },
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const { broadcastToRoom } = await import('../../src/utils/broadcast.js');
    const participantListCalls = (broadcastToRoom as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[2] as { type: string }).type === 'participantList'
    );
    expect(participantListCalls).toHaveLength(1);
    const payload = (
      participantListCalls[0][2] as {
        payload: { participants: Array<{ id: string }> };
      }
    ).payload;
    expect(payload.participants).toHaveLength(1);
    expect(payload.participants[0].id).toBe(OTHER_ID);
  });

  it('should handle DynamoDB query error and return 500', async () => {
    // Mock participant query to throw error
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB query error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Internal server error');
  });

  it('should handle a non-conditional update error and return 500', async () => {
    mockRowByConnection();
    mockRowRead({
      roomId: ROOM_ID,
      participantId: PARTICIPANT_ID,
      isModerator: false,
      connectionId: CONNECTION_ID,
    });
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB update error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Internal server error');
  });

  it('should handle broadcast error but still return success', async () => {
    mockRowByConnection();
    mockRowRead({ roomId: ROOM_ID, participantId: PARTICIPANT_ID, isModerator: false });
    mockDynamoDB.send.mockResolvedValueOnce({}); // conditional REMOVE connectionId
    mockDynamoDB.send.mockResolvedValueOnce({}); // decrement connectionCount

    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      liveParticipant(OTHER_ID, false),
    ]);

    const { broadcastToRoom } = await import('../../src/utils/broadcast.js');
    (broadcastToRoom as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Broadcast error')
    );

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('disconnected');
    expect(body.payload.message).toBe('Disconnected');
  });
});
