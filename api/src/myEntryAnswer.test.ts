// A volunteer who corrected a word works with THEIR word from then on - on every screen, in their
// task list, in what their example is stamped with, and in whether their own recording "matches".
// See myEntryAnswer.ts. The record itself stays untouched until a curator confirms.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from './testSupport.js';
import { submitContribution } from './handlers/submitContribution.js';
import { getEntryReview } from './handlers/getEntryReview.js';
import { getEtymologyReview } from './handlers/getEtymologyReview.js';
import { submitExample } from './handlers/submitExample.js';
import { listMyAssignments } from './handlers/listMyAssignments.js';
import { listUtterances } from './handlers/listUtterances.js';
import { loadAxisDecided } from './reviewShared.js';
import { writeCitationInTransaction } from './handlers/upstreamCitations.js';

const NS = 'testmine_';
const pool = getTestPool();
let ada: string;
let ben: string;

/** Speakers are not in cleanUpTestData's scope, and they reference users - so they, and the
 * utterances referencing them, go first. */
async function cleanUp(): Promise<void> {
  await pool.query("delete from utterances where word_id like 'testmine\\_%'");
  await pool.query("delete from speakers where display_name like 'testmine\\_%'");
  await cleanUpTestData(pool, NS);
}

beforeAll(async () => {
  await cleanUp();
  const mk = async (email: string) =>
    (
      await pool.query<{ user_id: string }>(
        'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
        [`${NS}${email}`, email, 'volunteer'],
      )
    ).rows[0].user_id;
  ada = await mk('ada@example.com');
  ben = await mk('ben@example.com');
});

afterAll(async () => {
  await cleanUp();
  await pool.end();
});

let seq = 0;
async function word(): Promise<string> {
  seq += 1;
  const wordId = `${NS}owo${seq}`;
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    'owo',
    ['o', 'wo'],
    'hand',
  ]);
  await writeCitationInTransaction(pool, wordId, { exemptReason: 'test word' }, ada);
  return wordId;
}

/** Ada corrects the tone and rewords the definition - an ordinary entry answer. */
async function adaCorrects(wordId: string): Promise<void> {
  await submitContribution(
    pool,
    {
      axis: 'entry',
      wordId,
      proposedValue: {
        action: 'respell',
        newDisplayText: 'ọwọ́',
        newSyllables: ['ọ', 'wọ́'],
        definitionAction: 'custom',
        definitionText: 'the hand',
      },
    },
    ada,
  );
}

async function recordAs(wordId: string, userId: string, displayText: string, syllables: string[]): Promise<void> {
  const speaker = await pool.query<{ speaker_id: string }>(
    'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
    [`${NS}speaker${seq}_${displayText}`, userId],
  );
  await pool.query(
    `insert into utterances (word_id, speaker_id, blob_path, recorded_display_text, recorded_syllables)
     values ($1, $2, $3, $4, $5)`,
    [wordId, speaker.rows[0].speaker_id, `utterances/${wordId}-${seq}.wav`, displayText, syllables],
  );
}

describe('the word as the volunteer has said it is', () => {
  it('reaches the entry and etymology screens, spelling and definition both, marked as theirs', async () => {
    const wordId = await word();
    await adaCorrects(wordId);

    const entry = await getEntryReview(pool, wordId, ada);
    expect(entry.displayText).toBe('owo'); // the record is untouched
    expect(entry.myProposedEntry).toMatchObject({
      displayText: 'ọwọ́',
      syllables: ['ọ', 'wọ́'],
      definition: 'the hand',
      spellingChanged: true,
      definitionChanged: true,
      recordDisplayText: 'owo',
      recordDefinition: 'hand',
    });
    expect((await getEtymologyReview(pool, wordId, ada)).myProposedEntry).toMatchObject({ displayText: 'ọwọ́' });
  });

  it('is only ever their own - Ben still sees the record', async () => {
    const wordId = await word();
    await adaCorrects(wordId);
    expect((await getEntryReview(pool, wordId, ben)).myProposedEntry).toBeNull();
  });

  it('shows in their task list', async () => {
    const wordId = await word();
    await pool.query('insert into assignments (word_id, user_id) values ($1, $2)', [wordId, ada]);
    await adaCorrects(wordId);
    const mine = (await listMyAssignments(pool, ada)).find((a) => a.wordId === wordId);
    expect(mine).toMatchObject({ displayText: 'ọwọ́', recordDisplayText: 'owo' });
  });

  it('stamps their example with the spelling they illustrated, not the record\'s', async () => {
    const wordId = await word();
    await adaCorrects(wordId);
    await submitExample(
      pool,
      wordId,
      { exampleType: 'usage_phrase', exampleText: 'ọwọ́ mi', translation: 'my hand', audioBase64: Buffer.from('RIFF').toString('base64') },
      ada,
    );
    const row = await pool.query<{ recorded_word_text: string }>(
      'select recorded_word_text from word_examples where word_id = $1 and submitted_by = $2',
      [wordId, ada],
    );
    expect(row.rows[0].recorded_word_text).toBe('ọwọ́');
  });

  it('counts their recording of their own spelling as matching, in the task status and the badge', async () => {
    const wordId = await word();
    await adaCorrects(wordId);
    await recordAs(wordId, ada, 'ọwọ́', ['ọ', 'wọ́']);

    expect(await loadAxisDecided(pool, wordId, ada)).toMatchObject({ audio: true, audioDiverges: false });
    const own = await listUtterances(pool, wordId, ada);
    expect(own.every((u) => !u.divergesFromGolden)).toBe(true);
  });

  it('flags a recording of the OLD spelling once they have corrected it', async () => {
    const wordId = await word();
    await recordAs(wordId, ada, 'owo', ['o', 'wo']);
    expect(await loadAxisDecided(pool, wordId, ada)).toMatchObject({ audioDiverges: false });
    await adaCorrects(wordId);
    expect(await loadAxisDecided(pool, wordId, ada)).toMatchObject({ audioDiverges: true });
  });

  it('keeps the publish view for a curator reviewing everyone\'s recordings', async () => {
    const wordId = await word();
    await adaCorrects(wordId);
    await recordAs(wordId, ada, 'ọwọ́', ['ọ', 'wọ́']);
    // Not yet confirmed, so publish would drop it - and the all-speakers view says so.
    const all = await listUtterances(pool, wordId, ada, { includeOtherSpeakers: true });
    expect(all.some((u) => u.divergesFromGolden)).toBe(true);
  });
});
