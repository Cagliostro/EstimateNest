import { describe, it, expect } from 'vitest';
import { apiClient } from './api-client';

describe('apiClient', () => {
  it('should be defined', () => {
    expect(apiClient).toBeDefined();
  });

  it('should have createRoom method', () => {
    expect(typeof apiClient.createRoom).toBe('function');
  });

  it('should have joinRoom method', () => {
    expect(typeof apiClient.joinRoom).toBe('function');
  });
});
