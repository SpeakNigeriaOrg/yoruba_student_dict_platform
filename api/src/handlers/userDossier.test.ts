// The user detail screen had no data behind it at all: #/users/{id} rendered an assignment
// manager and never named the person it was about. These verify the join that fixes it -
// against real Postgres, because most of what it does is read views (contributor_release_rights)
// and count across six tables, none of which a unit test would exercise honestly.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRIBUTOR_TERMS_VERSION } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { loadUserDossier } from './userDossier.js';
import { UserNotFoundError } from './errors.js';

const NS = 'testudoss_';
const pool = getTestPool();

/** speakers.user_id has no ON DELETE CASCADE - a voice outlives the account deliberately -
 * so a namespaced speaker blocks cleanUpTestData's users delete. Same shape as
 * rightsRoster.test.ts, which owns its speaker rows for the same reason. */
async function cleanUp() {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query(
    'delete from contribution_grants where speaker_id in (select speaker_id from speakers where display_name like $1)',
    [`${NS}%`],
  );
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
  await cleanUpTestData(pool, NS);
}

beforeAll(cleanUp);

afterAll(async () => {
  await cleanUp();
  await pool.end();
});

async function register(local: string, role: 'curator' | 'volunteer' = 'volunteer', displayName: string | null = null) {
  const r = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}${local}@example.com`, displayName, role],
  );
  return r.rows[0].user_id;
}

let wordSeq = 0;
async function word(): Promise<string> {
  wordSeq += 1;
  const wordId = `${NS}w${wordSeq}`;
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    'ikun',
    ['i', 'kun'],
    'stomach',
  ]);
  return wordId;
}

const load = (userId: string) => loadUserDossier(pool, userId, CONTRIBUTOR_TERMS_VERSION);

describe('loadUserDossier', () => {
  it('reports the basics - the email above all, which the screen never showed', async () => {
    const userId = await register('basics', 'curator', 'Ada Lovelace');
    const d = await load(userId);

    expect(d.email).toBe(`${NS}basics@example.com`);
    expect(d.displayName).toBe('Ada Lovelace');
    expect(d.role).toBe('curator');
    expect(d.createdAt).toBeTruthy();
    expect(d.userId).toBe(userId);
  });

  it('reports a user with no display name without inventing one', async () => {
    // display_name is nullable and most rows have none - the email is the identity, and the
    // screen falls back to it rather than showing a blank heading.
    const d = await load(await register('nameless'));
    expect(d.displayName).toBeNull();
    expect(d.email).toBe(`${NS}nameless@example.com`);
  });

  it('is 404, not an empty dossier, for a user that does not exist', async () => {
    await expect(load(randomUUID())).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("says nobody has been asked for a grant rather than defaulting to agreed", async () => {
    // 0019's whole point: no row means nobody asked. It must never read as consent.
    const d = await load(await register('ungranted'));
    expect(d.rights.releaseState).toBe('unknown');
    expect(d.rights.coversCurrentTerms).toBe(false);
    expect(d.rights.agreedVersion).toBeNull();
  });

  it('reads the grant through the rights view, and marks a current agreement as covering', async () => {
    const userId = await register('agreed');
    await pool.query(
      `insert into contribution_grants (user_id, instrument, instrument_ref, agreed, stated_on, recorded_by)
       values ($1, 'in_app_acceptance', $2, true, current_date, $1)`,
      [userId, CONTRIBUTOR_TERMS_VERSION],
    );

    const d = await load(userId);
    expect(d.rights.releaseState).toBe('agreed');
    expect(d.rights.agreedVersion).toBe(CONTRIBUTOR_TERMS_VERSION);
    expect(d.rights.coversCurrentTerms).toBe(true);
  });

  it('does NOT count an agreement to an older wording as covering the current one', async () => {
    // Consent to v1 is not consent to v2. Without the version beside the state, someone who
    // needs asking again is indistinguishable from someone fully covered.
    const userId = await register('stale');
    await pool.query(
      `insert into contribution_grants (user_id, instrument, instrument_ref, agreed, stated_on, recorded_by)
       values ($1, 'in_app_acceptance', 'contributor-terms-v0', true, current_date, $1)`,
      [userId],
    );

    const d = await load(userId);
    expect(d.rights.releaseState).toBe('agreed');
    expect(d.rights.coversCurrentTerms).toBe(false);
    expect(d.rights.agreedVersion).toBe('contributor-terms-v0');
  });

  it('lets a later withdrawal win, the way the view defines it', async () => {
    const userId = await register('revoked');
    await pool.query(
      `insert into contribution_grants (user_id, instrument, instrument_ref, agreed, stated_on, recorded_by)
       values ($1, 'in_app_acceptance', $2, true, current_date - 2, $1)`,
      [userId, CONTRIBUTOR_TERMS_VERSION],
    );
    await pool.query(
      `insert into contribution_grants (user_id, instrument, instrument_ref, agreed, stated_on,
                                        revoked_at, revoked_reason, recorded_by)
       values ($1, 'in_app_acceptance', $2, true, current_date, now(), 'asked us to stop', $1)`,
      [userId, CONTRIBUTOR_TERMS_VERSION],
    );

    const d = await load(userId);
    expect(d.rights.releaseState).toBe('revoked');
    expect(d.rights.coversCurrentTerms).toBe(false);
    expect(d.rights.revokedReason).toBe('asked us to stop');
  });

  it('splits contributions by axis and by status, so excluded work is visible as excluded', async () => {
    const userId = await register('worker');
    const w1 = await word();
    const w2 = await word();
    const mk = (wordId: string, axis: string, status: string) =>
      pool.query(
        `insert into contributions (word_id, axis, proposed_value, submitted_by, status)
         values ($1, $2, '{}'::jsonb, $3, $4)`,
        [wordId, axis, userId, status],
      );
    await mk(w1, 'entry', 'active');
    await mk(w2, 'entry', 'superseded');
    await mk(w1, 'etymology', 'excluded');

    const d = await load(userId);
    const entry = d.contributions.find((c) => c.axis === 'entry');
    const etym = d.contributions.find((c) => c.axis === 'etymology');
    expect(entry).toMatchObject({ active: 1, superseded: 1, excluded: 0 });
    expect(etym).toMatchObject({ active: 0, excluded: 1 });
  });

  it('lists recent contributions newest first, keeping the ones with no word', async () => {
    // A 'new_entry' proposal has a null word_id by construction, so an inner join would hide
    // exactly the work of someone whose main activity is proposing new words.
    const userId = await register('proposer');
    const w = await word();
    await pool.query(
      `insert into contributions (word_id, axis, proposed_value, submitted_by, submitted_at)
       values ($1, 'entry', '{}'::jsonb, $2, now() - interval '1 hour')`,
      [w, userId],
    );
    await pool.query(
      `insert into contributions (word_id, axis, proposed_value, submitted_by, submitted_at)
       values (null, 'new_entry', '{}'::jsonb, $1, now())`,
      [userId],
    );

    const d = await load(userId);
    expect(d.recentContributions).toHaveLength(2);
    expect(d.recentContributions[0].axis).toBe('new_entry');
    expect(d.recentContributions[0].wordId).toBeNull();
    expect(d.recentContributions[1].displayText).toBe('ikun');
  });

  it('counts assignments, decisions and authored words', async () => {
    const curator = await register('curator', 'curator');
    const w = await word();
    await pool.query('insert into assignments (word_id, user_id) values ($1, $2)', [w, curator]);
    await pool.query(
      `insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', '{}'::jsonb, $2)`,
      [w, curator],
    );
    await pool.query('update golden_record set updated_by = $2 where word_id = $1', [w, curator]);

    const d = await load(curator);
    expect(d.assignedWordCount).toBe(1);
    expect(d.decisionsMade).toBe(1);
    expect(d.wordsTouched).toBe(1);
  });

  it('reports zeroes rather than missing fields for someone who has done nothing yet', async () => {
    // The commonest row on the screen: a pre-registered invitee who has not logged in.
    const d = await load(await register('fresh'));
    expect(d).toMatchObject({
      contributions: [],
      speakers: [],
      recentContributions: [],
      exampleCount: 0,
      utteranceCount: 0,
      imageCount: 0,
      wordsTouched: 0,
      decisionsMade: 0,
      assignedWordCount: 0,
    });
  });

  it('finds the voice behind the account and what it has recorded', async () => {
    const userId = await register('speaker');
    const w = await word();
    const speaker = await pool.query<{ speaker_id: string }>(
      'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
      [`${NS}voice`, userId],
    );
    await pool.query(
      // recorded_display_text/recorded_syllables are not-null since 0006: a recording's
      // syllable identity is frozen at capture, never reinterpreted under a later spelling.
      `insert into utterances (word_id, speaker_id, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 'x.wav', 'ikun', $3)`,
      [w, speaker.rows[0].speaker_id, ['i', 'kun']],
    );

    const d = await load(userId);
    expect(d.speakers).toHaveLength(1);
    expect(d.speakers[0]).toMatchObject({ displayName: `${NS}voice`, utteranceCount: 1 });
    expect(d.utteranceCount).toBe(1);
  });
});
