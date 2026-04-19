import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { CacheManager } from '../../src/utils/cache.js';
import { Participant, Round } from '@estimatenest/shared';

// Mock DynamoDB DocumentClient
const mockSend = vi.fn();
const mockDocClient = {
  send: mockSend,
} as unknown as DynamoDBDocumentClient;

describe('CacheManager', () => {
  let cache: CacheManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new CacheManager(
      mockDocClient,
      'test-participants-table',
      'test-rounds-table',
      'test-rooms-table'
    );
  });

  describe('getParticipantsWithCache', () => {
    it('should fetch participants from DynamoDB on first call', async () => {
      const mockParticipants: Participant[] = [
        {
          id: 'p1',
          roomId: 'room1',
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
        {
          id: 'p2',
          roomId: 'room1',
          connectionId: 'conn2',
          name: 'Bob',
          avatarSeed: 'seed2',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: true,
        },
      ];
      mockSend.mockResolvedValueOnce({ Items: mockParticipants });

      const participants = await cache.getParticipantsWithCache('room1');

      expect(participants).toEqual(mockParticipants);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(expect.any(QueryCommand));
      const command = mockSend.mock.calls[0][0] as QueryCommand;
      expect(command.input.TableName).toBe('test-participants-table');
      expect(command.input.KeyConditionExpression).toBe('roomId = :roomId');
      expect(command.input.ExpressionAttributeValues).toEqual({ ':roomId': 'room1' });
    });

    it('should return cached participants within TTL', async () => {
      const mockParticipants: Participant[] = [
        {
          id: 'p1',
          roomId: 'room1',
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
      ];
      mockSend.mockResolvedValueOnce({ Items: mockParticipants });

      // First call populates cache
      await cache.getParticipantsWithCache('room1');
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Second call within 3 seconds should use cache
      const participants2 = await cache.getParticipantsWithCache('room1');
      expect(participants2).toEqual(mockParticipants);
      expect(mockSend).toHaveBeenCalledTimes(1); // No additional call

      // Invalidate cache and call again
      cache.invalidateParticipants('room1');
      mockSend.mockResolvedValueOnce({ Items: [] });
      await cache.getParticipantsWithCache('room1');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should fetch again after TTL expires', async () => {
      const mockParticipants1: Participant[] = [
        {
          id: 'p1',
          roomId: 'room1',
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
      ];
      const mockParticipants2: Participant[] = [
        {
          id: 'p2',
          roomId: 'room1',
          connectionId: 'conn2',
          name: 'Bob',
          avatarSeed: 'seed2',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: true,
        },
      ];
      mockSend.mockResolvedValueOnce({ Items: mockParticipants1 });
      mockSend.mockResolvedValueOnce({ Items: mockParticipants2 });

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      await cache.getParticipantsWithCache('room1');
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Advance time beyond TTL (3 seconds + 1ms)
      vi.spyOn(Date, 'now').mockReturnValue(now + 3001);

      const participants2 = await cache.getParticipantsWithCache('room1');
      expect(participants2).toEqual(mockParticipants2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('getActiveRoundWithCache', () => {
    it('should fetch active round from DynamoDB using GSI', async () => {
      const mockRound: Round = {
        id: 'round1',
        roomId: 'room1',
        title: 'Test round',
        description: 'Description',
        startedAt: '2025-01-01T00:00:00Z',
        revealedAt: undefined,
        isRevealed: false,
      };
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            roundId: 'round1',
            roomId: 'room1',
            title: 'Test round',
            description: 'Description',
            startedAt: '2025-01-01T00:00:00Z',
            isRevealed: false,
          },
        ],
      });

      const round = await cache.getActiveRoundWithCache('room1');

      expect(round).toEqual(mockRound);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(expect.any(QueryCommand));
      const command = mockSend.mock.calls[0][0] as QueryCommand;
      expect(command.input.TableName).toBe('test-rounds-table');
      expect(command.input.IndexName).toBe('RoomIdStartedAtIndex');
      expect(command.input.KeyConditionExpression).toBe('roomId = :roomId');
      expect(command.input.FilterExpression).toBe('isRevealed = :false');
      expect(command.input.ScanIndexForward).toBe(false);
      expect(command.input.Limit).toBe(1);
    });

    it('should return null when no active round', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      const round = await cache.getActiveRoundWithCache('room1');

      expect(round).toBeNull();
    });
  });

  describe('getRoomWithCache', () => {
    it('should fetch room from DynamoDB', async () => {
      const mockRoom = { id: 'room1', shortCode: 'ABC123', autoRevealEnabled: true };
      mockSend.mockResolvedValueOnce({ Item: mockRoom });

      const room = await cache.getRoomWithCache('room1');

      expect(room).toEqual(mockRoom);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(expect.any(GetCommand));
      const command = mockSend.mock.calls[0][0] as GetCommand;
      expect(command.input.TableName).toBe('test-rooms-table');
      expect(command.input.Key).toEqual({ id: 'room1', sk: 'META' });
    });

    it('should return undefined when room not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const room = await cache.getRoomWithCache('room1');

      expect(room).toBeUndefined();
    });
  });

  describe('invalidation', () => {
    it('should invalidate participant cache', async () => {
      const mockParticipants: Participant[] = [
        {
          id: 'p1',
          roomId: 'room1',
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
      ];
      mockSend.mockResolvedValueOnce({ Items: mockParticipants });
      mockSend.mockResolvedValueOnce({ Items: [] });

      await cache.getParticipantsWithCache('room1');
      cache.invalidateParticipants('room1');
      await cache.getParticipantsWithCache('room1');

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should clear all caches', () => {
      cache.clearAll();
      const stats = cache.getStats();
      expect(stats).toEqual({
        participantCacheSize: 0,
        activeRoundCacheSize: 0,
        roomCacheSize: 0,
      });
    });
  });
});
