import { describe, expect, it } from 'vitest';
import { parseClientPrincipal } from './auth.js';

function encodePrincipal(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

describe('parseClientPrincipal', () => {
  it('returns null for a missing header', () => {
    expect(parseClientPrincipal(null)).toBeNull();
    expect(parseClientPrincipal(undefined)).toBeNull();
    expect(parseClientPrincipal('')).toBeNull();
  });

  it('returns null for a header that is not valid base64-encoded JSON', () => {
    expect(parseClientPrincipal('not valid base64 json!!!')).toBeNull();
  });

  it('returns null when the decoded JSON has no userId', () => {
    expect(parseClientPrincipal(encodePrincipal({ userDetails: 'someone' }))).toBeNull();
  });

  it('parses a well-formed SWA client principal header', () => {
    const encoded = encodePrincipal({
      identityProvider: 'github',
      userId: 'abc123',
      userDetails: 'octocat',
      userRoles: ['anonymous', 'authenticated'],
      claims: [{ typ: 'name', val: 'Octo Cat' }],
    });
    expect(parseClientPrincipal(encoded)).toEqual({
      identityProvider: 'github',
      userId: 'abc123',
      userDetails: 'octocat',
      userRoles: ['anonymous', 'authenticated'],
      claims: [{ typ: 'name', val: 'Octo Cat' }],
    });
  });

  it('defaults userRoles to an empty array when absent', () => {
    const encoded = encodePrincipal({ userId: 'abc123' });
    expect(parseClientPrincipal(encoded)?.userRoles).toEqual([]);
  });
});
