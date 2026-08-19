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

  it('accepts a hyphen, which the deriver has always produced', () => {
    // `rẹ́rìn-ín` derives `rerin-in_to_laugh`, and this refused it - a contradiction rather than a
    // policy, since orthographyInsensitiveForm strips tone marks and underdots and nothing else.
    // Leading and trailing forms included: the interfix `-kí-` and the `i-` prefixes are real
    // corpus entries, and the hyphen is the only thing telling a bound affix from the free word.
    for (const id of ['rerin-in_to_laugh', 'ile-iwe_school', 'aarun-un_illness', '-ola_wealth', 'i-_prefix']) {
      expect(() => assertWordIdShape(id)).not.toThrow();
    }
  });

  it('agrees with orthographyInsensitiveForm, which is where ids come from', () => {
    // The guarantee is only real if the deriving function cannot produce something this refuses.
    // `ọwọ́` is the hard case: underdot and tone on the same vowel.
    //
    // Asserted against WORD_ID_PATTERN itself, NOT against a regex written here. This test had its
    // own `/^[a-z0-9_-]+$/` - looser than the pattern it was standing in for - so when `ilé-ìwé`
    // was added and the hyphen was added alongside it to make the line pass, the two rules
    // disagreed and nothing failed. That is exactly the drift this test exists to prevent, so it
    // can only ever read the real constant.
    for (const spelling of ['ọwọ́', 'ẹ jọ̀ọ́', 'Ṣóyínká', 'gban̄gba', 'ilé-ìwé', 'rẹ́rìn-ín', 'aárùn-ún', '-ọlá']) {
      const base = orthographyInsensitiveForm(spelling).replace(/\s+/g, '_');
      expect(base).toMatch(WORD_ID_PATTERN);
      expect(() => assertWordIdShape(base)).not.toThrow();
    }
  });

  it('refuses a spelling used as an id, which is the mistake it exists to catch', () => {
    // This is what would have travelled into a filename, a URL and a bucket key.
    expect(() => assertWordIdShape('ọwọ́_hand')).toThrow(InvalidWordIdError);
    expect(() => assertWordIdShape('o ṣé')).toThrow(InvalidWordIdError);
    expect(() => assertWordIdShape('Ṣóyínká')).toThrow(InvalidWordIdError);
  });

  it('refuses uppercase, spaces, slashes and dots', () => {
    // The hyphen is admitted, the path characters are not - `../etc/passwd` still has both a dot
    // and a slash, which is what made it dangerous.
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
