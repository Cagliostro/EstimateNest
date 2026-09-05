import { describe, it, expect } from 'vitest';
import { generateShortCode, createAvatarSeed } from '@estimatenest/shared';

describe('Shared utilities', () => {
  it('generateShortCode returns a string of correct length', () => {
    const code = generateShortCode();
    expect(code).toBeTypeOf('string');
    expect(code.length).toBe(6);
  });

  it('createAvatarSeed returns deterministic seed', () => {
    const seed = createAvatarSeed('Test User');
    expect(seed).toBe('test-user');
  });

  it('createAvatarSeed returns random seed for empty name', () => {
    const seed = createAvatarSeed();
    expect(seed).toBeTypeOf('string');
    expect(seed.length).toBeGreaterThan(0);
  });
});
