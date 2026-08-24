import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { loadDictionarySurvey, summariseDictionary } from './dictionarySurvey.js';

const NS = 'testsurvey_';
const pool = getTestPool();
let curatorId: string;
let speakerAId: string;
let speakerBId: string;

async function cleanUpSpeakers(): Promise<void> {
  await pool.query('delete from utterances where speaker_id in (select speaker_id from speakers where display_name like $1)', [
    `${NS}%`,
  ]);
  await pool.query('delete from speakers where display_name like $1', [`${NS}%`]);
}

beforeAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  const user = await pool.query<{ user_id: string }>(
    "insert into users (email, display_name, role) values ($1, 'Survey Curator', 'curator') returning user_id",
    [`${NS}curator@example.com`],
  );
  curatorId = user.rows[0].user_id;
  for (const name of [`${NS}speakerA`, `${NS}speakerB`]) {
    await pool.query('insert into speakers (display_name) values ($1)', [name]);
  }
  const speakers = await pool.query<{ speaker_id: string; display_name: string }>(
    'select speaker_id, display_name from speakers where display_name like $1 order by display_name',
    [`${NS}%`],
  );
  speakerAId = speakers.rows[0].speaker_id;
  speakerBId = speakers.rows[1].speaker_id;
});

afterAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  await pool.end();
});

beforeEach(async () => {
  await cleanUpTestData(pool, `${NS}w`);
});

async function insertWord(wordId: string, syllables = ['ọ', 'wọ́'], extra: Record<string, unknown> = {}): Promise<void> {
  await pool.query(
    `insert into golden_record (word_id, display_text, syllables, definition, pos, english_gloss)
     values ($1, $2, $3, $4, $5, $6)`,
    [wordId, syllables.join(''), syllables, 'hand', extra.pos ?? null, extra.englishGloss ?? null],
  );
}

async function recordWord(
  wordId: string,
  speakerId: string,
  opts: { matching?: boolean; syllables?: string[]; withClips?: boolean; clipSyllables?: string[] } = {},
): Promise<void> {
  const golden = await pool.query<{ display_text: string; syllables: string[] }>(
    'select display_text, syllables from golden_record where word_id = $1',
    [wordId],
  );
  const matching = opts.matching ?? true;
  const text = matching ? golden.rows[0].display_text : `${golden.rows[0].display_text}-old`;
  const syllables = opts.syllables ?? (matching ? golden.rows[0].syllables : ['stale']);
  const utterance = await pool.query<{ utterance_id: string }>(
    `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables, audio_data)
     values ($1, $2, 1, 'x', $3, $4, $5) returning utterance_id`,
    [wordId, speakerId, text, syllables, Buffer.from('wav')],
  );
  const clipSyllables = opts.clipSyllables ?? syllables;
  if (opts.withClips) {
    const take2 = await pool.query<{ utterance_id: string }>(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
       values ($1, $2, 2, 'x', $3, $4) returning utterance_id`,
      [wordId, speakerId, text, syllables],
    );
    for (const [i, syllable] of clipSyllables.entries()) {
      await pool.query(
        `insert into syllable_observations
           (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive,
            syllable_orthography_insensitive, legacy_syllable_key, start_time_s, end_time_s, blob_path, audio_data)
         values ($1, $2, $3, $3, $3, $3, 0, 0.3, 'x', $4)`,
        [take2.rows[0].utterance_id, i, syllable, Buffer.from('clip')],
      );
    }
  }
  void utterance;
}

async function surveyFor(wordId: string) {
  const all = await loadDictionarySurvey(pool);
  return all.find((w) => w.wordId === wordId)!;
}

describe('the dictionary survey', () => {
  it('reports the corpus, not the caller - a word another speaker recorded reads as recorded', async () => {
    // The defect this exists to end: Browse called loadAxisDecidedBatch, whose flags are
    // per-user, so a word other people had fully recorded read as "not yet recorded". This
    // handler takes no userId at all, which is the structural version of that guarantee.
    const wordId = `${NS}wcovered`;
    await insertWord(wordId);
    await recordWord(wordId, speakerAId, { withClips: true });

    const row = await surveyFor(wordId);
    expect(row.speakerCount).toBe(1);
    expect(row.fullyCoveredSpeakerCount).toBe(1);
  });

  it('separates golden from provisional from untouched', async () => {
    const untouched = `${NS}wnone`;
    const opined = `${NS}wprov`;
    const ruled = `${NS}wgold`;
    for (const id of [untouched, opined, ruled]) await insertWord(id);
    await pool.query(
      `insert into contributions (word_id, axis, proposed_value, resolved_value, value_fingerprint, submitted_by)
       values ($1, 'entry', '{}'::jsonb, '{}'::jsonb, 'fp', $2)`,
      [opined, curatorId],
    );
    await pool.query("insert into word_decisions (word_id, axis, decision, decided_by) values ($1, 'entry', '{}', $2)", [
      ruled,
      curatorId,
    ]);

    expect((await surveyFor(untouched)).entry).toBe('none');
    expect((await surveyFor(opined)).entry).toBe('provisional');
    expect((await surveyFor(ruled)).entry).toBe('golden');
  });

  it('counts a speaker as covering the word only when they recorded EVERY syllable', async () => {
    // A level plays one voice, so syllables covered by two different people cover nothing.
    // The word clip here is perfectly good - it is the syllable clips that fall short, which
    // is a different repair from "nobody has recorded this".
    const wordId = `${NS}wpartial`;
    await insertWord(wordId, ['ọ', 'wọ́']);
    await recordWord(wordId, speakerAId, { withClips: true, clipSyllables: ['ọ'] });

    const row = await surveyFor(wordId);
    expect(row.speakerCount).toBe(1);
    expect(row.fullyCoveredSpeakerCount).toBe(0);
    expect(row.gameBlockers).toContain('no_speaker_covers_syllables');
  });

  it('does not credit coverage assembled from two different voices', async () => {
    const wordId = `${NS}wsplitvoices`;
    await insertWord(wordId, ['ọ', 'wọ́']);
    await recordWord(wordId, speakerAId, { withClips: true, clipSyllables: ['ọ'] });
    await recordWord(wordId, speakerBId, { withClips: true, clipSyllables: ['wọ́'] });

    const row = await surveyFor(wordId);
    expect(row.speakerCount).toBe(2);
    expect(row.fullyCoveredSpeakerCount).toBe(0);
    expect(row.gameBlockers).toContain('no_speaker_covers_syllables');
  });

  it('tells a stale recording apart from no recording at all', async () => {
    const stale = `${NS}wstale`;
    await insertWord(stale);
    await recordWord(stale, speakerAId, { matching: false });

    const row = await surveyFor(stale);
    expect(row.speakerCount).toBe(0);
    expect(row.divergedSpeakerCount).toBe(1);
    expect(row.gameBlockers).toContain('only_stale_recordings');
    expect(row.gameBlockers).not.toContain('no_matching_recording');
  });

  it('names an uncited word instead of only counting it', async () => {
    // The drift report has always given uncited entries as a bare number. The exempt list
    // was fixed this way once already, on the grounds that a record nobody can find is not
    // a record.
    const uncited = `${NS}wuncited`;
    const exempt = `${NS}wexempt`;
    await insertWord(uncited);
    await insertWord(exempt);
    await pool.query(
      "insert into upstream_citations (word_id, exempt_reason, pin) values ($1, 'loanword', '{}'::jsonb)",
      [exempt],
    );

    expect((await surveyFor(uncited)).citation).toBe('uncited');
    expect((await surveyFor(exempt)).citation).toBe('exempt');
    expect((await surveyFor(exempt)).exemptReason).toBe('loanword');
  });

  it('surfaces the publication overrides, which were write-only before this', async () => {
    const wordId = `${NS}wpub`;
    await insertWord(wordId, ['ọ', 'wọ́'], { pos: 'noun', englishGloss: 'hand' });
    const row = await surveyFor(wordId);
    expect(row.pos).toBe('noun');
    expect(row.englishGloss).toBe('hand');
    // Exempt-with-both-fields is contributable; the citation row is what it still lacks.
    expect(row.wiktionaryBlockers).toEqual(['no_citation_row']);
  });

  it('blocks a word with no image, however well recorded', async () => {
    const wordId = `${NS}wnoimage`;
    await insertWord(wordId);
    await recordWord(wordId, speakerAId, { withClips: true });
    expect((await surveyFor(wordId)).gameBlockers).toEqual(['no_image']);

    await pool.query(
      "insert into word_images (word_id, art_style, image_data, blob_path) values ($1, 'cartoon', $2, 'i.png')",
      [wordId, Buffer.from('png')],
    );
    const withImage = await surveyFor(wordId);
    expect(withImage.imageCount).toBe(1);
    expect(withImage.gameBlockers).toEqual([]);
  });

  it('counts examples recorded under a superseded spelling', async () => {
    const wordId = `${NS}wexample`;
    await insertWord(wordId);
    await pool.query(
      `insert into word_examples (word_id, submitted_by, example_type, example_text, translation, audio_data, recorded_word_text)
       values ($1, $2, 'usage_phrase', 'mo ní ọwọ́', 'I have a hand', $3, 'a-different-spelling')`,
      [wordId, curatorId, Buffer.from('wav')],
    );
    const row = await surveyFor(wordId);
    expect(row.exampleCount).toBe(1);
    expect(row.staleExampleCount).toBe(1);
  });

  it('reports both directions of the component index', async () => {
    const part = `${NS}wpart`;
    const whole = `${NS}wwhole`;
    await insertWord(part);
    await insertWord(whole);
    await pool.query(
      'insert into golden_record_components (word_id, component_position, component_word_id) values ($1, 0, $2)',
      [whole, part],
    );
    expect((await surveyFor(whole)).componentCount).toBe(1);
    expect((await surveyFor(part)).usedAsComponentOfCount).toBe(1);
  });
});

describe('summariseDictionary', () => {
  it('summarises exactly the rows it was given, so a count cannot disagree with its list', async () => {
    const words = [
      { entry: 'golden', etymology: 'none', citation: 'cited', speakerCount: 3, divergedSpeakerCount: 0, imageCount: 1, exampleCount: 1, gameBlockers: [], wiktionaryBlockers: [] },
      { entry: 'none', etymology: 'none', citation: 'uncited', speakerCount: 0, divergedSpeakerCount: 2, imageCount: 0, exampleCount: 0, gameBlockers: ['only_stale_recordings', 'no_image'], wiktionaryBlockers: ['no_citation_row', 'no_part_of_speech'] },
    ] as unknown as Parameters<typeof summariseDictionary>[0];

    const overview = summariseDictionary(words);
    expect(overview.totalWords).toBe(2);
    expect(overview.entry).toEqual({ golden: 1, provisional: 0, none: 1 });
    expect(overview.citation).toEqual({ cited: 1, exempt: 0, uncited: 1 });
    expect(overview.audioCoverage).toEqual({ none: 1, one: 0, two: 0, threeOrMore: 1 });
    expect(overview.wordsWithStaleAudio).toBe(1);
    expect(overview.wordsWithNoImage).toBe(1);
    expect(overview.gameReady).toBe(1);
    expect(overview.gameBlockers.no_image).toBe(1);
    expect(overview.wiktionaryReady).toBe(1);
    expect(overview.wiktionaryBlockers.no_citation_row).toBe(1);
  });
});
