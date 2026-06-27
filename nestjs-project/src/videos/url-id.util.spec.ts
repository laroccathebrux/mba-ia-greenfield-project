import { generateUrlId } from './url-id.util';

describe('generateUrlId', () => {
  it('returns an 11-character string', () => {
    expect(generateUrlId()).toHaveLength(11);
  });

  it('only contains URL-safe base62 characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateUrlId()).toMatch(/^[0-9A-Za-z]{11}$/);
    }
  });

  it('produces no collisions across 10,000 generations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generateUrlId());
    }
    expect(ids.size).toBe(10_000);
  });

  it('returns a different value on successive calls', () => {
    expect(generateUrlId()).not.toBe(generateUrlId());
  });
});
