import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { loadRightsRoster } from './rightsRoster.js';

const NS = 'testrights_';
const pool = getTestPool();
let agreedUserId: string;

async function cleanUp(): Promise<void> {
  await pool.query(
    'delete from contribution_grants where speaker_id in (select speaker_id from speakers where display_name like $1)',
    [`${NS}%`],
  );
  await pool.query(
    'delete from contribution_grants where user_id in (select user_id from users where email like $1)',
    [`${NS}%`],
  );
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
}

beforeAll(async () => {
  await cleanUp();
  const agreed = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, 'Agreed', 'volunteer') returning user_id",
    [`${NS}agreed@example.com`],
  );
  agreedUserId = agreed.rows[0].user_id;
  await pool.query(
    "insert into users (email, display_name, role) values ($1, 'Unasked', 'volunteer')",
    [`${NS}unasked@example.com`],
  );
  await pool.query(
    `insert into contribution_grants (user_id, instrument, instrument_ref, stated_on, agreed, recorded_by)
     values ($1, 'in_app_acceptance', 'contributor-terms-v1', current_date, true, $1)`,
    [agreedUserId],
  );
  // A voice with no account - the population the in-app prompt structurally cannot reach.
  const legacy = await pool.query<{ speaker_id: string }>(
    'insert into speakers (display_name) values ($1) returning speaker_id',
    [`${NS}legacyvoice`],
  );
  await pool.query(
    `insert into golden_record (word_id, display_text, syllables) values ($1, 'x', array['x'])`,
    [`${NS}word`],
  );
  await pool.query(
    `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
     values ($1, $2, 1, 'x', 'x', array['x'])`,
    [`${NS}word`, legacy.rows[0].speaker_id],
  );
});

afterAll(async () => {
  await cleanUp();
  await pool.end();
});

describe('the rights roster', () => {
  it('answers "who have we not asked" - the question 0019 built the views for', async () => {
    const roster = await loadRightsRoster(pool, 'contributor-terms-v1');
    const unasked = roster.contributors.find((c) => c.email === `${NS}unasked@example.com`);
    const agreed = roster.contributors.find((c) => c.email === `${NS}agreed@example.com`);
    expect(unasked?.releaseState).toBe('unknown');
    expect(agreed?.releaseState).toBe('agreed');
    expect(agreed?.instrument).toBe('in_app_acceptance');
  });

  it('names a voice with no account, and counts what is at stake behind it', async () => {
    // Three such speakers carry 189 production recordings and cannot be reached by the
    // in-app prompt at all; only an out-of-band grant resolves them. Nothing has ever shown
    // that they are outstanding.
    const roster = await loadRightsRoster(pool, 'contributor-terms-v1');
    const legacy = roster.speakers.find((s) => s.displayName === `${NS}legacyvoice`);
    expect(legacy).toMatchObject({ releaseState: 'unknown', hasAccount: false, utteranceCount: 1 });
    expect(roster.counts.speakersWithoutAccount).toBeGreaterThanOrEqual(1);
    expect(roster.counts.utterancesWithoutAgreement).toBeGreaterThanOrEqual(1);
  });

  it('reports the wording currently in force, so an old acceptance can be spotted', async () => {
    const roster = await loadRightsRoster(pool, 'contributor-terms-v1');
    expect(roster.currentTermsVersion).toBe('contributor-terms-v1');
  });
});
