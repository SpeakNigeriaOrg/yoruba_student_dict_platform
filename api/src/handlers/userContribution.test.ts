// The user page's contribution rows used to link into the review screens - a form asking
// the curator for their own opinion, with no trace of what the person they clicked on had
// said. These cover the join that replaces it: four axes across three tables that share
// nothing but a person and a word.
//
// Against real Postgres, like userDossier.test.ts and for the same reason - most of what
// this does is joins and views (contributor_release_rights, speaker_release_rights) that a
// mocked pg would only pretend to exercise.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { ContributionNotFoundError, loadUserContribution } from './userContribution.js';
import { UserNotFoundError } from './errors.js';

const NS = 'testucon_';
const pool = getTestPool();

/** speakers.user_id has no ON DELETE CASCADE - a voice outlives the account deliberately -
 * so a namespaced speaker blocks cleanUpTestData's users delete. Same shape as
 * userDossier.test.ts, which owns its speaker rows for the same reason. */
async function cleanUp() {
  await pool.query(
    'delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)',
    [`${NS}%`],
  );
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

async function register(local: string) {
  const r = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}${local}@example.com`, null, 'volunteer'],
  );
  return r.rows[0].user_id;
}

let wordSeq = 0;
async function word(displayText = 'ìkùn', syllables = ['ì', 'kùn']): Promise<string> {
  wordSeq += 1;
  const wordId = `${NS}w${wordSeq}`;
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    displayText,
    syllables,
    'stomach',
  ]);
  return wordId;
}

interface ContributionSeed {
  axis?: string;
  status?: string;
  proposedValue?: unknown;
  resolvedValue?: unknown;
  fingerprint?: string | null;
  note?: string | null;
  submittedAt?: string;
}

async function contribute(
  userId: string,
  wordId: string | null,
  { axis = 'entry', status = 'active', proposedValue = {}, resolvedValue, fingerprint = null, note = null, submittedAt }: ContributionSeed = {},
): Promise<string> {
  const r = await pool.query<{ contribution_id: string }>(
    `insert into contributions (word_id, axis, proposed_value, resolved_value, value_fingerprint, note,
                                submitted_by, status, submitted_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, coalesce($9::timestamptz, now()))
     returning contribution_id`,
    [
      wordId,
      axis,
      JSON.stringify(proposedValue),
      resolvedValue === undefined ? null : JSON.stringify(resolvedValue),
      fingerprint,
      note,
      userId,
      status,
      submittedAt ?? null,
    ],
  );
  return r.rows[0].contribution_id;
}

async function speakerFor(userId: string, local: string): Promise<string> {
  const r = await pool.query<{ speaker_id: string }>(
    'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
    [`${NS}${local}`, userId],
  );
  return r.rows[0].speaker_id;
}

async function record(
  wordId: string,
  speakerId: string,
  { displayText = 'ìkùn', syllables = ['ì', 'kùn'], take = 1 }: { displayText?: string; syllables?: string[]; take?: number } = {},
) {
  const r = await pool.query<{ utterance_id: string }>(
    `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text,
                             recorded_syllables, audio_data, delivery_media_type, duration_s, status)
     values ($1, $2, $3, 'test/path.wav', $4, $5, decode('414243', 'hex'), 'audio/wav', 1.25, 'segmented')
     returning utterance_id`,
    [wordId, speakerId, take, displayText, syllables],
  );
  return r.rows[0].utterance_id;
}

async function example(
  userId: string,
  wordId: string,
  { text = 'ìkùn mi', translation = 'my stomach', recordedWordText = 'ìkùn', excludedReason }: { text?: string; translation?: string; recordedWordText?: string; excludedReason?: string } = {},
) {
  const r = await pool.query<{ example_id: string }>(
    `insert into word_examples (word_id, submitted_by, example_type, example_text, translation,
                                audio_data, recorded_word_text, excluded_by, excluded_at, excluded_reason)
     values ($1, $2, 'usage_phrase', $3, $4, decode('414243', 'hex'), $5,
             case when $6::text is null then null else $2::uuid end,
             case when $6::text is null then null else now() end, $6)
     returning example_id`,
    [wordId, userId, text, translation, recordedWordText, excludedReason ?? null],
  );
  return r.rows[0].example_id;
}

const load = (userId: string, contributionId: string) => loadUserContribution(pool, userId, contributionId);

describe('loadUserContribution', () => {
  it('reads back the claim itself, unfiltered by status', async () => {
    const userId = await register('claim');
    const w = await word();
    const id = await contribute(userId, w, {
      axis: 'etymology',
      status: 'superseded',
      proposedValue: { componentsAction: 'custom', components: ['a', 'b'] },
      resolvedValue: { kind: 'etymology', components: ['a', 'b'], atomic: false },
      fingerprint: 'fp-etym',
      note: 'thought again about this',
    });

    const d = await load(userId, id);
    expect(d.contribution.axis).toBe('etymology');
    // Superseded, and shown as such. 0013 kept these rows on purpose and every other query
    // in the app drops them.
    expect(d.contribution.status).toBe('superseded');
    expect(d.contribution.note).toBe('thought again about this');
    expect(d.contribution.resolvedValue).toEqual({ kind: 'etymology', components: ['a', 'b'], atomic: false });
    expect(d.contribution.proposedValue).toMatchObject({ componentsAction: 'custom' });
    expect(d.email).toBe(`${NS}claim@example.com`);
    expect(d.word).toMatchObject({ wordId: w, displayText: 'ìkùn', definition: 'stomach' });
  });

  it('is 404 for a contribution belonging to somebody else, not a view under the wrong name', async () => {
    // The whole screen is reached from one person's page. Rendering another account's claim
    // there would attribute it to the person whose name is on the heading.
    const ada = await register('ada');
    const ben = await register('ben');
    const w = await word();
    const bens = await contribute(ben, w);

    await expect(load(ada, bens)).rejects.toBeInstanceOf(ContributionNotFoundError);
  });

  it('is 404 for a user that does not exist, before it looks at the contribution', async () => {
    await expect(load(randomUUID(), randomUUID())).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it('carries the same person\'s other axes on the same word, and nobody else\'s', async () => {
    const ada = await register('sibling_ada');
    const ben = await register('sibling_ben');
    const w = await word();
    const entry = await contribute(ada, w, { axis: 'entry', submittedAt: '2026-01-01T00:00:00Z' });
    await contribute(ada, w, { axis: 'etymology', submittedAt: '2026-02-01T00:00:00Z' });
    await contribute(ben, w, { axis: 'etymology' });
    // A different word of theirs must not leak in either.
    await contribute(ada, await word(), { axis: 'entry' });

    const d = await load(ada, entry);
    expect(d.alsoOnThisWord).toHaveLength(1);
    expect(d.alsoOnThisWord[0].axis).toBe('etymology');
  });

  it('says whether a claim is what the record now holds, by fingerprint', async () => {
    const userId = await register('agrees');
    const w = await word();
    const agreed = await contribute(userId, w, { axis: 'entry', fingerprint: 'fp-live' });
    const overruled = await contribute(userId, w, { axis: 'etymology', fingerprint: 'fp-old' });
    await pool.query(
      `insert into word_decisions (word_id, axis, decision, value_fingerprint, decided_by)
       values ($1, 'entry', '{}'::jsonb, 'fp-live', $2), ($1, 'etymology', '{}'::jsonb, 'fp-new', $2)`,
      [w, userId],
    );

    const onEntry = await load(userId, agreed);
    expect(onEntry.contribution.agreesWithRecord).toBe(true);
    const onEtymology = await load(userId, overruled);
    expect(onEtymology.contribution.agreesWithRecord).toBe(false);
  });

  it('leaves agreement unknown rather than false when there is nothing to compare', async () => {
    // An undecided axis, and a pre-0013 row with no resolved outcome, are both "cannot
    // tell" - reporting either as a disagreement would put a dispute on screen that
    // nobody is having.
    const userId = await register('undecided');
    const w = await word();
    const undecided = await contribute(userId, w, { fingerprint: 'fp-x' });
    expect((await load(userId, undecided)).contribution.agreesWithRecord).toBeNull();

    const legacy = await contribute(userId, w, { axis: 'etymology', fingerprint: null });
    await pool.query(
      `insert into word_decisions (word_id, axis, decision, value_fingerprint, decided_by)
       values ($1, 'etymology', '{}'::jsonb, 'fp-whatever', $2)`,
      [w, userId],
    );
    expect((await load(userId, legacy)).contribution.agreesWithRecord).toBeNull();
  });

  it('carries their recordings of the word, with the audio, and no other speaker\'s', async () => {
    const ada = await register('voice_ada');
    const ben = await register('voice_ben');
    const w = await word();
    const id = await contribute(ada, w);
    await record(w, await speakerFor(ada, 'ada_voice'));
    await record(w, await speakerFor(ben, 'ben_voice'), { take: 2 });

    const d = await load(ada, id);
    expect(d.recordings).toHaveLength(1);
    expect(d.recordings[0].speakerName).toBe(`${NS}ada_voice`);
    // Playable, which is the point - the word dossier lists recordings and offers no way
    // to hear one.
    expect(d.recordings[0].audioDataBase64).toBe(Buffer.from('ABC').toString('base64'));
    expect(d.recordings[0].deliveryMediaType).toBe('audio/wav');
    expect(d.recordings[0].matchesGolden).toBe(true);
    expect(d.recordings[0].releaseState).toBe('unknown');
    expect(d.recordings[0].durationS).toBe(1.25);
  });

  it('flags a take recorded under a spelling the word no longer has', async () => {
    const userId = await register('respelled');
    const w = await word();
    const id = await contribute(userId, w);
    await record(w, await speakerFor(userId, 'respelled_voice'), { displayText: 'ikun', syllables: ['i', 'kun'] });

    const d = await load(userId, id);
    expect(d.recordings[0].matchesGolden).toBe(false);
    expect(d.recordings[0].recordedDisplayText).toBe('ikun');
  });

  it("carries their example even when it has been excluded, and nobody else's", async () => {
    // At most one per person per word (0015's unique key, upserted by the handler), so this
    // is a list of one - and it is present rather than filtered, which is where it differs
    // from listExamples: "their example was removed as off-topic" is exactly what a curator
    // reading someone's record needs to see.
    const ada = await register('ex_ada');
    const ben = await register('ex_ben');
    const w = await word();
    const id = await contribute(ada, w);
    await example(ada, w, { text: 'off topic', excludedReason: 'not about this word' });
    await example(ben, w, { text: 'bens example' });

    const d = await load(ada, id);
    expect(d.examples).toHaveLength(1);
    expect(d.examples[0].exampleText).toBe('off topic');
    expect(d.examples[0].excludedReason).toBe('not about this word');
    expect(d.examples[0].excludedAt).toBeTruthy();
    expect(d.examples[0].audioDataBase64).toBe(Buffer.from('ABC').toString('base64'));
  });

  it('flags an example recorded under a spelling the word no longer has', async () => {
    const userId = await register('ex_respelled');
    const w = await word();
    const id = await contribute(userId, w);
    await example(userId, w, { recordedWordText: 'ikun' });

    const d = await load(userId, id);
    expect(d.examples[0].wordTextChanged).toBe(true);
    expect(d.examples[0].recordedWordText).toBe('ikun');
  });

  it('renders a new-word proposal, which has no word to hang on', async () => {
    // The case the word dossier structurally cannot show: 'new_entry' has a null word_id by
    // construction (0001's contributions_new_entry_word_id_null), so the user page rendered
    // these rows as unclickable text.
    const userId = await register('proposer');
    const id = await contribute(userId, null, {
      axis: 'new_entry',
      proposedValue: { proposedWordId: 'ikun_stomach', displayText: 'ìkùn', syllables: ['ì', 'kùn'] },
    });

    const d = await load(userId, id);
    expect(d.word).toBeNull();
    expect(d.contribution.axis).toBe('new_entry');
    expect(d.contribution.proposedValue).toMatchObject({ proposedWordId: 'ikun_stomach' });
    expect(d.alsoOnThisWord).toEqual([]);
    expect(d.examples).toEqual([]);
    expect(d.recordings).toEqual([]);
  });

  it('reports the release state so unpublishable work cannot be mistaken for cleared', async () => {
    const userId = await register('rights');
    const w = await word();
    const id = await contribute(userId, w);
    await pool.query(
      `insert into contribution_grants (user_id, instrument, instrument_ref, agreed, stated_on, recorded_by)
       values ($1, 'in_app_acceptance', 'contributor-terms-v1', true, current_date, $1)`,
      [userId],
    );

    const d = await load(userId, id);
    expect(d.releaseState).toBe('agreed');
  });

  it('defaults an ungranted account to unknown rather than to consent', async () => {
    const userId = await register('ungranted');
    const w = await word();
    const id = await contribute(userId, w);
    expect((await load(userId, id)).releaseState).toBe('unknown');
  });
});
