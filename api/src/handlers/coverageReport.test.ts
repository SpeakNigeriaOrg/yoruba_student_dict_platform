import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { loadCoverageReport } from './coverageReport.js';

const NS = 'testcov_';
const pool = getTestPool();
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
  for (const name of [`${NS}alpha`, `${NS}beta`]) {
    await pool.query('insert into speakers (display_name) values ($1)', [name]);
  }
  const rows = await pool.query<{ speaker_id: string }>(
    'select speaker_id from speakers where display_name like $1 order by display_name',
    [`${NS}%`],
  );
  speakerAId = rows.rows[0].speaker_id;
  speakerBId = rows.rows[1].speaker_id;
});

afterAll(async () => {
  await cleanUpSpeakers();
  await cleanUpTestData(pool, NS);
  await pool.end();
});

beforeEach(async () => {
  await pool.query('delete from utterances where word_id like $1', [`${NS}w%`]);
  await cleanUpTestData(pool, `${NS}w`);
});

async function word(wordId: string, syllables: string[]): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    syllables.join(''),
    syllables,
  ]);
}

async function record(
  wordId: string,
  speakerId: string,
  syllables: string[],
  opts: { clips?: string[]; image?: boolean } = {},
): Promise<void> {
  await pool.query(
    `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables, audio_data)
     values ($1, $2, 1, 'x', $3, $4, $5)`,
    [wordId, speakerId, syllables.join(''), syllables, Buffer.from('wav')],
  );
  const take2 = await pool.query<{ utterance_id: string }>(
    `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables)
     values ($1, $2, 2, 'x', $3, $4) returning utterance_id`,
    [wordId, speakerId, syllables.join(''), syllables],
  );
  for (const [i, syllable] of (opts.clips ?? syllables).entries()) {
    await pool.query(
      `insert into syllable_observations
         (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive,
          syllable_orthography_insensitive, legacy_syllable_key, start_time_s, end_time_s, blob_path, audio_data)
       values ($1, $2, $3, $3, $3, $3, 0, 0.3, 'x', $4)`,
      [take2.rows[0].utterance_id, i, syllable, Buffer.from('clip')],
    );
  }
  if (opts.image) {
    await pool.query(
      "insert into word_images (word_id, art_style, image_data, blob_path) values ($1, 'cartoon', $2, 'i.png') on conflict do nothing",
      [wordId, Buffer.from('png')],
    );
  }
}

async function forSpeaker(id: string) {
  const report = await loadCoverageReport(pool);
  return report.speakers.find((s) => s.speakerId === id)!;
}

describe('per-speaker coverage', () => {
  it('counts a word playable only when ONE speaker did all of it and there is an image', async () => {
    await word(`${NS}wfull`, ['ka', 'su']);
    await record(`${NS}wfull`, speakerAId, ['ka', 'su'], { image: true });

    const alpha = await forSpeaker(speakerAId);
    expect(alpha.wordsRecorded).toBe(1);
    expect(alpha.wordsFullyCovered).toBe(1);
    expect(alpha.wordsPlayable).toBe(1);
  });

  it('does not let two voices add up to one playable word', async () => {
    // The reason this report is per speaker at all: a level plays one voice, so syllables
    // split between people cover nothing, and a corpus-wide percentage would hide it.
    await word(`${NS}wsplit`, ['ka', 'su']);
    await record(`${NS}wsplit`, speakerAId, ['ka', 'su'], { clips: ['ka'], image: true });
    await record(`${NS}wsplit`, speakerBId, ['ka', 'su'], { clips: ['su'] });

    expect((await forSpeaker(speakerAId)).wordsFullyCovered).toBe(0);
    expect((await forSpeaker(speakerBId)).wordsFullyCovered).toBe(0);
  });

  it('separates "recorded the word" from "playable", when the image is missing', async () => {
    await word(`${NS}wnoimg`, ['ka', 'su']);
    await record(`${NS}wnoimg`, speakerAId, ['ka', 'su']);

    const alpha = await forSpeaker(speakerAId);
    expect(alpha.wordsFullyCovered).toBe(1);
    expect(alpha.wordsPlayable).toBe(0);
  });

  it('flags a speaker below the floor at which any level is generated', async () => {
    await word(`${NS}wone`, ['ka']);
    await record(`${NS}wone`, speakerAId, ['ka'], { image: true });
    expect((await forSpeaker(speakerAId)).meetsLevelMinimum).toBe(false);
  });

  it('counts recordings the word has moved out from under', async () => {
    await word(`${NS}wstale`, ['ka', 'su']);
    await pool.query(
      `insert into utterances (word_id, speaker_id, take_number, blob_path, recorded_display_text, recorded_syllables, audio_data)
       values ($1, $2, 1, 'x', 'old-spelling', array['old'], $3)`,
      [`${NS}wstale`, speakerAId, Buffer.from('wav')],
    );
    const alpha = await forSpeaker(speakerAId);
    expect(alpha.staleRecordings).toBe(1);
    expect(alpha.wordsRecorded).toBe(0);
  });
});

describe('syllable stock', () => {
  it('names a syllable the dictionary needs and nobody has recorded', async () => {
    await word(`${NS}wgap`, [`${NS}rare`]);
    const report = await loadCoverageReport(pool);
    expect(report.unrecordedSyllables).toContain(`${NS}rare`);
  });

  it('flags a syllable one speaker recorded more than once, which publish resolves arbitrarily', async () => {
    // db/README.md names 15 of these in production. The publish step takes the first row it
    // finds with no tiebreak, so which take ships is chance - and nothing has shown it.
    await word(`${NS}wdup`, [`${NS}dup`, `${NS}dup`]);
    await record(`${NS}wdup`, speakerAId, [`${NS}dup`, `${NS}dup`]);

    const report = await loadCoverageReport(pool);
    const entry = report.syllables.find((s) => s.syllable === `${NS}dup`)!;
    expect(entry.recordings).toBe(2);
    expect(entry.speakersWithDuplicates).toBe(1);
  });

  it('counts how many words need each syllable', async () => {
    await word(`${NS}wa`, [`${NS}shared`]);
    await word(`${NS}wb`, [`${NS}shared`]);
    const report = await loadCoverageReport(pool);
    expect(report.syllables.find((s) => s.syllable === `${NS}shared`)!.wordsUsingIt).toBe(2);
  });
});
