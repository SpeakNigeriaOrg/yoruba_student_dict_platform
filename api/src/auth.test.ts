import { describe, expect, it } from 'vitest';
import { findEmailClaim, parseClientPrincipal, type ClientPrincipal } from './auth.js';

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
      claims: [{ typ: 'email', val: 'octocat@example.com' }],
    });
    expect(parseClientPrincipal(encoded)).toEqual({
      identityProvider: 'github',
      userId: 'abc123',
      userDetails: 'octocat',
      userRoles: ['anonymous', 'authenticated'],
      claims: [{ typ: 'email', val: 'octocat@example.com' }],
    });
  });

  it('defaults userRoles to an empty array when absent', () => {
    const encoded = encodePrincipal({ userId: 'abc123' });
    expect(parseClientPrincipal(encoded)?.userRoles).toEqual([]);
  });
});

describe('findEmailClaim', () => {
  const basePrincipal: ClientPrincipal = {
    identityProvider: 'github',
    userId: 'x',
    userDetails: 'x',
    userRoles: [],
  };

  it('returns null when there are no claims at all', () => {
    expect(findEmailClaim(basePrincipal)).toBeNull();
  });

  it('returns null when no claim has an email-shaped type', () => {
    const principal = { ...basePrincipal, claims: [{ typ: 'name', val: 'Octo Cat' }] };
    expect(findEmailClaim(principal)).toBeNull();
  });

  it('finds an email claim by the plain "email" type', () => {
    const principal = { ...basePrincipal, claims: [{ typ: 'email', val: 'a@example.com' }] };
    expect(findEmailClaim(principal)).toBe('a@example.com');
  });

  it('finds an email claim by the XML SOAP claim type URI some providers use', () => {
    const principal = {
      ...basePrincipal,
      claims: [{ typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', val: 'b@example.com' }],
    };
    expect(findEmailClaim(principal)).toBe('b@example.com');
  });

  it('matches claim types case-insensitively', () => {
    const principal = { ...basePrincipal, claims: [{ typ: 'EMAIL', val: 'c@example.com' }] };
    expect(findEmailClaim(principal)).toBe('c@example.com');
  });
});
