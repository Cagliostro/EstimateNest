import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleModeratorVacancy,
  MODERATOR_HANDOFF_GRACE_MS,
} from '../../src/utils/moderator.js';
import { TransactionCanceledException, ConditionalCheckFailedException } from '@aws-sdk/lib-dynamodb';

const { mockDocClient, mockCacheManager } = vi.hoisted(() => {
  return {
    mockDocClient: {
      send: vi.fn(),
    },
    mockCacheManager: {
      getParticipantsWithCache: vi.fn(),
      invalidateParticipants: vi.fn(),
    },
  };
});

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn() },
  GetCommand: vi.fn(),
  UpdateCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
  TransactWriteCommand: vi.fn(function (this: { input: unknown }, input: unknown) {
    this.input = input;
  }),
  ConditionalCheckFailedException: class extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'ConditionalCheckFailedException';
    }
  },
  TransactionCanceledException: class extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'TransactionCanceledException';
    }
  },
}));

vi.mock('../../src/utils/dynamodb', () => ({
  getDocClient: vi.fn(() => mockDocClient),
}));

vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

const ROOM_ID = '11111111-2222-4333-8444-555555555555';
const MODERATOR_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONNECTING_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';

function vacancyAt(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function liveParticipant(id: string, isModerator: boolean, joinedMsAgo: number) {
  return {
    id,
    roomId: ROOM_ID,
    name: `User ${id}`,
    connectionId: `conn-${id}`,
    joinedAt: new Date(Date.now() - joinedMsAgo).toISOString(),
    lastSeenAt: new Date().toISOString(),
    isModerator,
  };
}

/** Rows a moderator whose connection is gone: no mapping, stale REST poll. */
function offlineModeratorRow() {
  return {
    id: MODERATOR_ID,
    roomId: ROOM_ID,
    name: 'Moderator',
    connectionId: 'REST',
    joinedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 300_000).toISOString(),
    isModerator: true,
  };
}

function transactInputs() {
  return mockDocClient.send.mock.calls
    .map((call) => (call[0] as { input?: { TransactItems?: unknown[] } }).input)
    .filter((input) => input && input.TransactItems);
}

describe('handleModeratorVacancy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocClient.send.mockReset();
    mockDocClient.send.mockImplementation(() => {
      throw new Error('Unexpected call to DynamoDB - test should mock this call');
    });
    mockCacheManager.getParticipantsWithCache.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();
    process.env.ROOMS_TABLE = 'test-rooms-table';
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';
  });

  it('does nothing when no vacancy is pending', async () => {
    mockDocClient.send.mockResolvedValueOnce({ Item: {} });

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    expect(result).toEqual({ handled: false, reason: 'no-vacancy' });
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
  });

  it('clears the vacancy when the moderator row is present again', async () => {
    const vacantAt = vacancyAt(10_000);
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      liveParticipant(MODERATOR_ID, true, 3600_000),
    ]);
    mockDocClient.send.mockResolvedValueOnce({}); // clear vacancy update

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    expect(result).toEqual({ handled: true, reason: 'moderator-present' });
    expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(ROOM_ID);
    expect(transactInputs()).toHaveLength(0); // no promotion — vacancy cleared only
    const updateInput = mockDocClient.send.mock.calls[1][0] as {
      input: { ConditionExpression: string };
    };
    expect(updateInput.input.ConditionExpression).toBe('moderatorVacantAt = :observed');
  });

  it('clears the vacancy when the connecting participant IS the moderator (reload)', async () => {
    const vacantAt = vacancyAt(10_000);
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    // Moderator row exists but is offline; the reconnect is happening right now.
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([offlineModeratorRow()]);
    mockDocClient.send.mockResolvedValueOnce({}); // clear vacancy update

    const result = await handleModeratorVacancy(ROOM_ID, MODERATOR_ID);

    expect(result).toEqual({ handled: true, reason: 'moderator-present' });
  });

  it('waits out the grace window before promoting anyone', async () => {
    const vacantAt = vacancyAt(5_000); // inside the 60 s grace
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      offlineModeratorRow(),
      liveParticipant(CONNECTING_ID, false, 120_000),
    ]);

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    expect(result).toEqual({ handled: false, reason: 'no-vacancy' });
    expect(transactInputs()).toHaveLength(0);
  });

  it('promotes the oldest present participant once the grace expired', async () => {
    const vacantAt = vacancyAt(MODERATOR_HANDOFF_GRACE_MS + 60_000);
    const oldestId = 'dddddddd-eeee-4eee-8fff-bbbbbbbbbbbb';
    const newcomerId = 'eeeeeeee-ffff-4eee-8fff-cccccccccccc';
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      offlineModeratorRow(),
      liveParticipant(newcomerId, false, 10_000),
      liveParticipant(oldestId, false, 3600_000),
    ]);
    mockDocClient.send.mockResolvedValueOnce({}); // transact write succeeds

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    expect(result).toEqual({ handled: true, reason: 'promoted' });
    const transact = transactInputs()[0].TransactItems as Array<{
      Update: { UpdateExpression: string; Key: { participantId?: string } };
    }>;
    // Vacancy removal + promotion of the oldest + demotion of the moderator,
    // all in one transaction.
    expect(transact).toHaveLength(3);
    expect(transact[0].Update.UpdateExpression).toBe('REMOVE moderatorVacantAt');
    expect(transact[1].Update.Key.participantId).toBe(oldestId);
    expect(transact[1].Update.UpdateExpression).toBe('SET isModerator = :true');
    expect(transact[2].Update.Key.participantId).toBe(MODERATOR_ID);
    expect(transact[2].Update.UpdateExpression).toBe('SET isModerator = :false');
  });

  it('promotes without demoting when no moderator row exists', async () => {
    const vacantAt = vacancyAt(MODERATOR_HANDOFF_GRACE_MS + 60_000);
    const oldestId = 'dddddddd-eeee-4eee-8fff-bbbbbbbbbbbb';
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      liveParticipant(oldestId, false, 3600_000),
      liveParticipant(CONNECTING_ID, false, 10_000),
    ]);
    mockDocClient.send.mockResolvedValueOnce({});

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    expect(result).toEqual({ handled: true, reason: 'promoted' });
    const transact = transactInputs()[0].TransactItems as Array<{ Update: unknown }>;
    expect(transact).toHaveLength(2);
  });

  it('does not promote when no present candidates exist', async () => {
    const vacantAt = vacancyAt(MODERATOR_HANDOFF_GRACE_MS + 60_000);
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([offlineModeratorRow()]);

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    expect(result).toEqual({ handled: false, reason: 'no-candidates' });
    expect(transactInputs()).toHaveLength(0);
  });

  it('surrenders cleanly when the promotion transaction loses a race', async () => {
    const vacantAt = vacancyAt(MODERATOR_HANDOFF_GRACE_MS + 60_000);
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      offlineModeratorRow(),
      liveParticipant(CONNECTING_ID, false, 120_000),
    ]);
    mockDocClient.send.mockRejectedValueOnce(new TransactionCanceledException('Cancelled'));

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    // Another connect already resolved the vacancy — nothing to do.
    expect(result).toEqual({ handled: false, reason: 'no-vacancy' });
  });

  it('treats a failed vacancy clear as no-vacancy', async () => {
    const vacantAt = vacancyAt(10_000);
    mockDocClient.send.mockResolvedValueOnce({ Item: { moderatorVacantAt: vacantAt } });
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      liveParticipant(MODERATOR_ID, true, 3600_000),
    ]);
    mockDocClient.send.mockRejectedValueOnce(
      new ConditionalCheckFailedException('Conditional check failed')
    );

    const result = await handleModeratorVacancy(ROOM_ID, CONNECTING_ID);

    expect(result).toEqual({ handled: false, reason: 'no-vacancy' });
  });
});
