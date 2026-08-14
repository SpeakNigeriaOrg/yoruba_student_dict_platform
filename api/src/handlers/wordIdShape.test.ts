import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { createWord } from './createWord.js';
import { createPhrase } from './createPhrase.js';
import { assertWordIdShape, InvalidWordIdError, WORD_ID_PATTERN } from './wordIdShape.js';

const NS = 'testwid_';
const pool = getTestPool();
let curatorUserId: string;

const EXEMPT = { exemptReason: 'test word, no upstream entry' } as const;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const result = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = result.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('assertWordIdShape', () => {
  it('accepts what AddWord actually derives', () => {
    // orthographyInsensitiveForm strips tone marks AND underdots, then the meaning hint is
    // slugged - so the result is plain ASCII by construction. These are production shapes.
    for (const id of ['owo_hand', 'jeun_eat', 'o_se_thank_you', 'a_him_9f2c1b04', 'ile_iwe_school']) {
      expect(() => assertWordIdShape(id)).not.toThrow();
    }
  });

  it('agrees with orthographyInsensitiveForm, which is where ids come from', () => {
    // The guarantee is only real if the deriving function cannot produce something this
    // refuses. `ọwọ́` is the hard case: underdot and tone on the same vowel.
    for (const spelling of ['ọwọ́', 'ẹ jọ̀ọ́', 'Ṣóyínká', 'gban̄gba', 'ilé-ìwé']) {
      const base = orthographyInsensitiveForm(spelling).replace(/\s+/g, '_');
      expect(base).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it('refuses a spelling used as an id, which is the mistake it exists to catch', () => {
    // This is what would have travelled into a filename, a URL and a bucket key.
    expect(() => assertWordIdShape('ọwọ́_hand')).toThrow(InvalidWordIdError);
    expect(() => assertWordIdShape('o ṣé')).toThrow(InvalidWordIdError);
    expect(() => assertWordIdShape('Ṣóyínká')).toThrow(InvalidWordIdError);
  });

  it('refuses uppercase, spaces, slashes and dots', () => {
    for (const id of ['Owo_hand', 'owo hand', 'owo/hand', 'owo.hand', '../etc/passwd', '']) {
      expect(() => assertWordIdShape(id)).toThrow(InvalidWordIdError);
    }
  });

  it('is anchored, so a partial match cannot pass', () => {
    expect(WORD_ID_PATTERN.test('ok_id\nṣ')).toBe(false);
  });
});

describe('the creation handlers enforce it', () => {
  it('createWord refuses a badly shaped id, and writes nothing', async () => {
    const bad = `${NS}ọwọ́_hand`;
    await expect(
      createWord(pool, { wordId: bad, displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'], citation: EXEMPT }, curatorUserId),
    ).rejects.toThrow(InvalidWordIdError);
    const rows = await pool.query('select 1 from golden_record where word_id = $1', [bad]);
    expect(rows.rowCount).toBe(0);
  });

  it('createPhrase refuses one too', async () => {
    const part = `${NS}part_one`;
    await createWord(pool, { wordId: part, displayText: 'o', syllables: ['o'], citation: EXEMPT }, curatorUserId);
    await expect(
      createPhrase(
        pool,
        { wordId: `${NS}o ṣé`, displayText: 'o ṣé', syllables: ['o', 'ṣé'], components: [part] },
        curatorUserId,
      ),
    ).rejects.toThrow(InvalidWordIdError);
  });

  it('accepts the id AddWord would really have sent', async () => {
    const good = `${NS}owo_hand`;
    await createWord(
      pool,
      { wordId: good, displayText: 'ọwọ́', syllables: ['ọ', 'wọ́'], citation: EXEMPT },
      curatorUserId,
    );
    const rows = await pool.query<{ display_text: string }>('select display_text from golden_record where word_id = $1', [
      good,
    ]);
    // The id is ASCII and the SPELLING keeps everything - that separation is the point.
    expect(rows.rows[0].display_text).toBe('ọwọ́');
  });
});
