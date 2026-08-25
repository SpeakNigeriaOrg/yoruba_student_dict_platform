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
    expect(result.axisDecided).toEqual({ entry: false, etymology: false, audio: false, audioDiverges: false, example: false });
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

// A speaker who has just corrected a spelling has said what they think the word IS. The
// recorder used to offer them the old one to read aloud - the wrong prompt, and a recording
// publish would drop. Nothing in this result could see their answer: displayText is
// golden_record's, and a contribution never reaches golden_record. Survivable while a
// curator's answer wrote the record directly; universal once everyone contributes.
describe('the caller\'s own pending answer about the spelling', () => {
  async function proposeSpelling(wordId: string, by: string, displayText: string, syllables: string[]): Promise<void> {
    await pool.query(
      `insert into contributions (word_id, axis, proposed_value, resolved_value, value_fingerprint, submitted_by)
       values ($1, 'entry', '{}'::jsonb, $2, $3, $4)`,
      [wordId, { kind: 'entry', displayText, syllables, definitionText: null, citedEntryId: null }, `fp-${displayText}`, by],
    );
  }

  it('is null when they have not answered', async () => {
    const wordId = `${NS}prop_none`;
    await insertWord(wordId, 'owo', ['o', 'wo']);
    expect((await getEntryReview(pool, wordId, userId)).myProposedEntry).toBeNull();
  });

  it('reports the spelling they proposed, with its syllables', async () => {
    const wordId = `${NS}prop_mine`;
    await insertWord(wordId, 'owo', ['o', 'wo']);
    await proposeSpelling(wordId, userId, 'ọwọ́', ['ọ', 'wọ́']);

    const result = await getEntryReview(pool, wordId, userId);
    expect(result.myProposedEntry).toEqual({ displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'] });
    // The record itself is untouched - a contribution is not a decision.
    expect(result.displayText).toBe('owo');
  });

  it('is null when their answer agrees with the record - there is nothing to prefer', async () => {
    const wordId = `${NS}prop_same`;
    await insertWord(wordId, 'owo', ['o', 'wo']);
    await proposeSpelling(wordId, userId, 'owo', ['o', 'wo']);
    expect((await getEntryReview(pool, wordId, userId)).myProposedEntry).toBeNull();
  });

  it('ignores a difference of Unicode composition alone', async () => {
    // Five production words store their text in NFD. Treating those as "you proposed
    // something different" would put a spurious notice in front of every one of them.
    const wordId = `${NS}prop_nfd`;
    await insertWord(wordId, 'ọwọ́'.normalize('NFD'), ['ọ'.normalize('NFD'), 'wọ́'.normalize('NFD')]);
    await proposeSpelling(wordId, userId, 'ọwọ́'.normalize('NFC'), ['ọ'.normalize('NFC'), 'wọ́'.normalize('NFC')]);
    expect((await getEntryReview(pool, wordId, userId)).myProposedEntry).toBeNull();
  });

  it("does not hand one person another person's answer", async () => {
    // The recording is this speaker's own pronunciation, so the prompt has to be their own
    // claim about the word - not whatever a different contributor last said.
    const wordId = `${NS}prop_theirs`;
    await insertWord(wordId, 'owo', ['o', 'wo']);
    await proposeSpelling(wordId, curatorId, 'ọwọ́', ['ọ', 'wọ́']);

    expect((await getEntryReview(pool, wordId, userId)).myProposedEntry).toBeNull();
    expect((await getEntryReview(pool, wordId, curatorId)).myProposedEntry).toEqual({
      displayText: 'ọwọ́',
      syllables: ['ọ', 'wọ́'],
    });
  });

  it('ignores an answer they have since superseded', async () => {
    const wordId = `${NS}prop_superseded`;
    await insertWord(wordId, 'owo', ['o', 'wo']);
    await proposeSpelling(wordId, userId, 'ọwọ', ['ọ', 'wọ']);
    await pool.query("update contributions set status = 'superseded' where word_id = $1", [wordId]);
    expect((await getEntryReview(pool, wordId, userId)).myProposedEntry).toBeNull();
  });
});
