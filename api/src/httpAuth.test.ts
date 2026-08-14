// httpAuth.test.ts
//
// The contributor-agreement gate lives in requireUser rather than in each write handler,
// so this is where it is proved. A test per endpoint would be the same assertion twenty
// times; what actually needs holding is that the METHOD is what distinguishes a
// contribution from a look, and that the one exempt endpoint stays exempt.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HttpRequest } from '@azure/functions';
import { CONTRIBUTOR_TERMS_VERSION } from '@yoruba-student-dict-platform/shared';
import { ContributionsPausedError, requireCurator, requireUser } from './httpAuth.js';
import { recordContributorGrant } from './handlers/contributionGrants.js';
import { cleanUpTestData, getTestPool } from './testSupport.js';

const NS = 'testha_';
const pool = getTestPool();
let userId: string;

/** Just enough of an HttpRequest for requireUser: the principal header and the method.
 * Constructing a real one needs the Functions runtime, and nothing here exercises it. */
function request(method: string, email: string): HttpRequest {
  const principal = Buffer.from(
    JSON.stringify({ identityProvider: 'google', userId: 'sub-1', userDetails: email, userRoles: ['authenticated'] }),
    'utf8',
  ).toString('base64');
  return {
    method,
    headers: { get: (name: string) => (name === 'x-ms-client-principal' ? principal : null) },
  } as unknown as HttpRequest;
}

async function clean() {
  await pool.query(
    `delete from contribution_grants
      where speaker_id in (select speaker_id from speakers where display_name like $1)
         or user_id in (select user_id from users where email like $1)`,
    [`${NS}%`],
  );
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
}

const EMAIL = `${NS}teacher@example.com`;

beforeAll(clean);

beforeEach(async () => {
  await clean();
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [EMAIL, `${NS}A Teacher`, 'curator'],
  );
  userId = result.rows[0].user_id;
});

afterAll(async () => {
  await clean();
  await pool.end();
});

async function decline() {
  await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
    termsVersion: CONTRIBUTOR_TERMS_VERSION,
    declineReason: 'would rather not',
  });
}

describe('requireUser and the contributor agreement', () => {
  it('lets an account that has never been asked write', async () => {
    // 'unknown' is not 'declined'. Someone ahead of the paperwork, or whose grant lookup
    // failed, is not someone who said no - and stopping their day's work over it would be
    // the gate doing harm in the name of consent.
    await expect(requireUser(request('POST', EMAIL))).resolves.toMatchObject({ email: EMAIL });
  });

  it('refuses a write from an account that declined', async () => {
    await decline();
    await expect(requireUser(request('POST', EMAIL))).rejects.toThrow(ContributionsPausedError);
  });

  it('refuses every write method, not just POST', async () => {
    // The rule is "anything that is not a look", so DELETE and PATCH - unassigning a word,
    // changing a role - are covered by the same line rather than by remembering them.
    await decline();
    await expect(requireUser(request('DELETE', EMAIL))).rejects.toThrow(ContributionsPausedError);
    await expect(requireUser(request('PATCH', EMAIL))).rejects.toThrow(ContributionsPausedError);
  });

  it('still lets a declined account READ', async () => {
    // Declining stops contributions, not access. The dictionary is still theirs to consult.
    await decline();
    await expect(requireUser(request('GET', EMAIL))).resolves.toMatchObject({ email: EMAIL });
  });

  it('refuses a curator write too - a decision is authored content as much as a recording', async () => {
    await decline();
    await expect(requireCurator(request('POST', EMAIL))).rejects.toThrow(ContributionsPausedError);
  });

  it('surfaces as a 403, because it extends ForbiddenError', async () => {
    // What keeps this a one-file change: every route file already maps ForbiddenError to
    // 403, so none of them needed touching. If this ever stops being true the gate starts
    // returning 400 "insufficient permissions" from twenty endpoints at once.
    await decline();
    const err = await requireUser(request('POST', EMAIL)).catch((e) => e);
    expect(err.name).toBe('ContributionsPausedError');
    expect(err.message).toContain('declined');
  });

  it('exempts the agreement endpoint, so a declined account can change its mind', async () => {
    // The dead end this avoids: the only way back is a write, and the gate would refuse
    // exactly that write.
    await decline();
    await expect(requireUser(request('POST', EMAIL), { allowWithoutGrant: true })).resolves.toMatchObject({
      email: EMAIL,
    });
  });

  it('lifts as soon as they accept', async () => {
    await decline();
    await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
      termsVersion: CONTRIBUTOR_TERMS_VERSION,
      openReleasePermitted: true,
    });
    await expect(requireUser(request('POST', EMAIL))).resolves.toMatchObject({ email: EMAIL });
  });

  it('does not block someone who agreed to everything except open release', async () => {
    // 'internal_only' is a complete answer, and the material it produces is exactly what
    // the engagement is for. Only a refusal blocks.
    await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
      termsVersion: CONTRIBUTOR_TERMS_VERSION,
      openReleasePermitted: false,
    });
    await expect(requireUser(request('POST', EMAIL))).resolves.toMatchObject({ email: EMAIL });
  });
});
