// Replaces getSpellingReview.test.ts and getDefinitionReview.test.ts.
// Carries over both files' cases (diagnosis status, syllable-split
// sub-check, gloss-based definition proposal, missing-vs-proposed, reading
// back an already-recorded decision) and adds the one thing only the merged
// handler can get wrong: the two halves must resolve against DIFFERENT
// diagnoseEntry runs - overridden for the written form, un-overridden for
// the meaning link (see getEntryReview.ts's note 2).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { applyEntryDecision } from './applyEntryDecision.js';
import { getEntryReview } from './getEntryReview.js';
import { WordNotFoundError } from './errors.js';

const NS = 'testgetentry_';
const pool = getTestPool();
const seededKaikkiSenseIds: string[] = [];
let userId: string;
let curatorId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const requester = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'volunteer') returning user_id",
    [`${NS}requester`, 'Test Requester'],
  );
  userId = requester.rows[0].user_id;
  const curator = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, $2, 'curator') returning user_id",
    [`${NS}curator`, 'Test Curator'],
  );
  curatorId = curator.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  if (seededKaikkiSenseIds.length > 0) {
    await pool.query('delete from kaikki_senses where sense_id = any($1)', [seededKaikkiSenseIds]);
  }
  await pool.end();
});

async function insertWord(
  wordId: string,
  displayText: string,
  syllables: string[] = [displayText],
  definition: string | null = null,
): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    displayText,
    syllables,
    definition,
  ]);
}

async function insertKaikkiSense(
  headword: string,
  canonicalValue: string,
  orthographyKey: string,
  glosses: string[],
): Promise<void> {
  const result = await pool.query<{ sense_id: string }>(
    `insert into kaikki_senses
       (pos, headword, canonical_value, canonical_inference_method, canonical_confidence, canonical_original_value, standard_forms, glosses)
     values ('noun', $1, $2, 'explicit_canonical_tag', 1.0, $1, $3, $4)
     returning sense_id`,
    [headword, canonicalValue, [canonicalValue], glosses],
  );
  const senseId = result.rows[0].sense_id;
  seededKaikkiSenseIds.push(senseId);
  await pool.query('insert into kaikki_sense_keys (sense_id, orthography_insensitive_key) values ($1, $2)', [
    senseId,
    orthographyKey,
  ]);
}

describe('getEntryReview', () => {
  it('rejects a word_id that does not exist', async () => {
    await expect(getEntryReview(pool, `${NS}nonexistent`, userId)).rejects.toThrow(WordNotFoundError);
  });

  it('returns the written-form half and the meaning half in one response', async () => {
    const wordId = `${NS}both_halves`;
    await insertWord(wordId, `${NS}bothword`, [`${NS}both`, 'word'], 'a current definition');

    const result = await getEntryReview(pool, wordId, userId);

    // written form
    expect(result.status).toBeDefined();
    expect(result.syllables).toEqual([`${NS}both`, 'word']);
    expect(result.syllableSplitStatus).toBeDefined();
    // meaning
    expect(result.definitionStatus).toBeDefined();
    expect(result.definitionCurrent).toBe('a current definition');
    // shared context
    expect(result.axisDecided).toEqual({ entry: false, etymology: false, audio: false, example: false });
  });

  it('proposes a definition from Kaikki glosses when none has been decided yet', async () => {
    const wordId = `${NS}proposed_word`;
    const headword = `${NS}kaikkiword`;
    await insertKaikkiSense(headword, headword, headword, ['the proposed gloss']);
    await insertWord(wordId, headword);

    const result = await getEntryReview(pool, wordId, userId);

    expect(result.definitionProposed).toBe('the proposed gloss');
    expect(result.definitionStatus).toBe('proposed');
  });

  it('reports missing (not proposed) with no current definition and no Kaikki match', async () => {
    const wordId = `${NS}missing_word`;
    await insertWord(wordId, `${NS}nomatchword`);

    const result = await getEntryReview(pool, wordId, userId);

    expect(result.definitionStatus).toBe('missing');
    expect(result.definitionCurrent).toBeNull();
  });

  it('reads back a recorded entry decision on both halves at once', async () => {
    const wordId = `${NS}decided_word`;
    await insertWord(wordId, `${NS}decidedword`, [`${NS}decidedword`], 'before');

    await applyEntryDecision(
      pool,
      wordId,
      { action: 'keep_ours', definitionAction: 'custom', definitionText: 'after', note: 'decided both' },
      curatorId,
    );

    const result = await getEntryReview(pool, wordId, userId);

    // The written-form half reflects its own decision rather than
    // re-proposing from scratch...
    expect(result.status).toBe('verified_keep_ours');
    // ...and the meaning half reflects the custom text that was written.
    expect(result.definitionCurrent).toBe('after');
    expect(result.note).toBe('decided both');
    expect(result.axisDecided.entry).toBe(true);
  });

  it('keeps the Kaikki-sourced meaning context after a spelling decision is recorded', async () => {
    // Guards the meaning half against being collapsed into the written-form
    // half: definitionSourceForm/definitionCandidateGlosses come out of
    // resolveDefinitionSource, fed by getEntryReview's SECOND, un-overridden
    // diagnoseEntry run. They must survive a recorded spelling decision.
    //
    // Note on scope: with action 'keep_ours' the overridden diagnosis happens
    // to keep the same matchedForm, so this pins down that the context is not
    // erased - it does not by itself distinguish the two diagnoseEntry runs.
    // The redirect test below is the one that exercises the full-corpus load
    // the merged handler depends on.
    const wordId = `${NS}indep_word`;
    const headword = `${NS}indepword`;
    await insertKaikkiSense(headword, headword, headword, ['independent gloss']);
    await insertWord(wordId, headword);

    const before = await getEntryReview(pool, wordId, userId);
    expect(before.definitionProposed).toBe('independent gloss');

    await applyEntryDecision(pool, wordId, { action: 'keep_ours', definitionAction: 'confirm' }, curatorId);

    const after = await getEntryReview(pool, wordId, userId);
    expect(after.status).toBe('verified_keep_ours');
    // 'confirmed' deliberately stops proposing (there is nothing left to
    // propose), but the source and its glosses are still resolved.
    expect(after.definitionStatus).toBe('confirmed');
    expect(after.definitionSourceForm).toBe(headword);
    expect(after.definitionCandidateGlosses).toEqual(['independent gloss']);
  });

  it('honours an explicit definitionSourceForm override pointing at another record', async () => {
    // Only possible because the full corpus is loaded, not just this word's
    // own orthography key - the whole point of the manual redirect.
    const wordId = `${NS}redirect_word`;
    const ownHeadword = `${NS}redirectword`;
    const otherHeadword = `${NS}elsewhereword`;
    await insertKaikkiSense(ownHeadword, ownHeadword, ownHeadword, ['its own gloss']);
    await insertKaikkiSense(otherHeadword, otherHeadword, otherHeadword, ['the redirected gloss']);
    await insertWord(wordId, ownHeadword);

    await applyEntryDecision(
      pool,
      wordId,
      { action: 'keep_ours', definitionAction: 'confirm', definitionSourceForm: otherHeadword },
      curatorId,
    );

    const result = await getEntryReview(pool, wordId, userId);
    expect(result.definitionSourceForm).toBe(otherHeadword);
    expect(result.definitionCandidateGlosses).toContain('the redirected gloss');
  });
});
