import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONTRIBUTOR_TERMS_VERSION } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { getGrantStatus, recordContributorGrant, TermsVersionMismatchError } from './contributionGrants.js';

const NS = 'testcg_';
const pool = getTestPool();
let userId: string;

/** Speakers are not covered by cleanUpTestData, and an acceptance CREATES one - so the
 * teardown here mirrors registerUtterance.test.ts's: speakers references users with no
 * ON DELETE CASCADE, so a speaker row left behind blocks the user delete. Grants cascade
 * from both sides, but are cleared explicitly anyway so a failed run leaves nothing that
 * changes the next run's answer - the whole point of this table is that state is
 * historical. */
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

beforeAll(clean);

beforeEach(async () => {
  await clean();
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}teacher@example.com`, `${NS}A Teacher`, 'volunteer'],
  );
  userId = result.rows[0].user_id;
});

afterAll(async () => {
  await clean();
  await pool.end();
});

describe('getGrantStatus', () => {
  it('says an account nobody has asked is unknown, and needs asking', async () => {
    // The state that must not be silently anything else: no row means no question put.
    const status = await getGrantStatus(pool, userId);
    expect(status.releaseState).toBe('unknown');
    expect(status.acceptedVersion).toBeNull();
    expect(status.needsAcceptance).toBe(true);
  });
});

describe('recordContributorGrant', () => {
  it('accepting records the agreement and stops the app asking again', async () => {
    const status = await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
      termsVersion: CONTRIBUTOR_TERMS_VERSION,
    });
    expect(status.releaseState).toBe('agreed');
    expect(status.acceptedVersion).toBe(CONTRIBUTOR_TERMS_VERSION);
    expect(status.needsAcceptance).toBe(false);
  });

  it('accepting names the account AND the voice, so both lookups resolve', async () => {
    // The reason acceptance sets both subjects: audio resolves by speaker and written
    // contributions by user, and neither should depend on the speakers.user_id link
    // still being right years later.
    await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
      termsVersion: CONTRIBUTOR_TERMS_VERSION,
    });
    const speaker = await pool.query<{ speaker_id: string; release_state: string }>(
      `select r.speaker_id, r.release_state
         from speaker_release_rights r
         join speakers s on s.speaker_id = r.speaker_id
        where s.user_id = $1`,
      [userId],
    );
    expect(speaker.rowCount).toBe(1);
    expect(speaker.rows[0].release_state).toBe('agreed');

    const row = await pool.query<{ speaker_id: string | null }>(
      'select speaker_id from contribution_grants where user_id = $1',
      [userId],
    );
    expect(row.rows[0].speaker_id).toBe(speaker.rows[0].speaker_id);
  });

  it('declining is recorded as an answer, and is not asked again', async () => {
    // "We asked and they said no" has to be distinguishable from "nobody asked", and a
    // prompt that reappears is how a no becomes a yes by attrition.
    const status = await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
      termsVersion: CONTRIBUTOR_TERMS_VERSION,
      declineReason: 'would rather not',
    });
    expect(status.releaseState).toBe('declined');
    expect(status.needsAcceptance).toBe(false);
  });

  it('a later answer supersedes an earlier one, without erasing it', async () => {
    await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
      termsVersion: CONTRIBUTOR_TERMS_VERSION,
    });
    const after = await recordContributorGrant(pool, userId, `${NS}A Teacher`, {
      termsVersion: CONTRIBUTOR_TERMS_VERSION,
      declineReason: 'changed my mind',
    });
    expect(after.releaseState).toBe('declined');
    // Both statements survive - a grant is a statement made on a date, and the record of
    // what someone agreed to is the reason to keep an instrument at all.
    const rows = await pool.query('select 1 from contribution_grants where user_id = $1', [userId]);
    expect(rows.rowCount).toBe(2);
  });

  it('refuses an answer to a different version of the wording', async () => {
    // Consent to v1 is not consent to v2, in either direction. A client that displayed
    // stale terms must not have its answer attributed to the current ones.
    await expect(
      recordContributorGrant(pool, userId, `${NS}A Teacher`, {
        termsVersion: 'contributor-terms-v0',
      }),
    ).rejects.toThrow(TermsVersionMismatchError);
    expect((await getGrantStatus(pool, userId)).releaseState).toBe('unknown');
  });

  it('asks again when the wording changes', async () => {
    // Simulated by writing a grant against an older version directly, since the current
    // version is a constant by design - what matters is that the comparison, not the
    // presence of a row, is what silences the prompt.
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}A Teacher`, userId],
    );
    await pool.query(
      `insert into contribution_grants
         (user_id, speaker_id, instrument, instrument_ref, stated_on, agreed)
       values ($1, $2, 'in_app_acceptance', 'contributor-terms-v0', current_date, true)`,
      [userId, speaker.rows[0].speaker_id],
    );
    const status = await getGrantStatus(pool, userId);
    // Still agreed - to something. The prompt returns because the VERSION differs, not
    // because the agreement is missing, which is the distinction the whole mechanism rests
    // on: their old answer stays valid for what it was an answer to.
    expect(status.releaseState).toBe('agreed');
    expect(status.needsAcceptance).toBe(true);
  });

  it('refuses to record an agreement with no version attached', async () => {
    // The constraint behind "asked once per version": a row claiming assent without saying
    // to what would silence the prompt forever and record nothing anyone agreed to.
    await expect(
      pool.query(
        `insert into contribution_grants (user_id, instrument, stated_on, agreed)
         values ($1, 'in_app_acceptance', current_date, true)`,
        [userId],
      ),
    ).rejects.toThrow(/contribution_grants_agreement_is_complete/);
  });
});
