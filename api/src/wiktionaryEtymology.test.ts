// Wiktionary's etymology text reaches every screen that shows a word's etymology, read from the
// current corpus by the word's citation - see wiktionaryEtymology.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from './testSupport.js';
import { loadWiktionaryEtymologyTexts } from './wiktionaryEtymology.js';
import { writeCitationInTransaction } from './handlers/upstreamCitations.js';
import { submitContribution } from './handlers/submitContribution.js';
import { listConsensus } from './handlers/listConsensus.js';
import { loadWordDossier } from './handlers/wordDossier.js';

const NS = 'testetytext_';
const ENTRY_NS = 'testetytext-entry-';
const pool = getTestPool();
let volunteer: string;

const SORO = `${NS}soro_speak`;
const BARE = `${NS}bare_word`;
const TEXT = 'Contraction of sọ + ọ̀rọ̀, literally “to say words”.';

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  volunteer = (
    await pool.query<{ user_id: string }>(
      "insert into users (email, display_name, role) values ($1, 'v', 'volunteer') returning user_id",
      [`${NS}v@example.com`],
    )
  ).rows[0].user_id;
  await insertTestKaikkiSense(pool, { entryId: `${ENTRY_NS}soro`, headword: 'soro', canonicalValue: 'sọ̀rọ̀', glosses: ['to speak'], etymologyText: TEXT });
  await insertTestKaikkiSense(pool, { entryId: `${ENTRY_NS}bare`, headword: 'bare', canonicalValue: 'bare', glosses: ['bare'], etymologyText: '  ' });
  for (const [wordId, spelling, entryId] of [
    [SORO, 'sọ̀rọ̀', `${ENTRY_NS}soro`],
    [BARE, 'bare', `${ENTRY_NS}bare`],
  ]) {
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [wordId, spelling, [spelling]]);
    await writeCitationInTransaction(pool, wordId, { entryId }, volunteer);
  }
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  await pool.end();
});

describe("Wiktionary's etymology text", () => {
  it("is the cited entry's text, and nothing for a blank one or an uncited word", async () => {
    const texts = await loadWiktionaryEtymologyTexts(pool, [SORO, BARE, `${NS}missing`]);
    expect(texts.get(SORO)).toBe(TEXT);
    expect(texts.has(BARE)).toBe(false);
    expect(texts.has(`${NS}missing`)).toBe(false);
  });

  it('comes with the dossier', async () => {
    expect((await loadWordDossier(pool, SORO)).wiktionaryEtymologyText).toBe(TEXT);
  });

  it('comes with an etymology consensus group, and not with an entry group', async () => {
    await submitContribution(pool, { axis: 'etymology', wordId: SORO, proposedValue: { componentsAction: 'confirm_atomic' } }, volunteer);
    await submitContribution(pool, { axis: 'entry', wordId: SORO, proposedValue: { action: 'keep_ours' } }, volunteer);
    const groups = await listConsensus(pool, { wordId: SORO });
    expect(groups.find((g) => g.axis === 'etymology')?.wiktionaryEtymologyText).toBe(TEXT);
    expect(groups.find((g) => g.axis === 'entry')?.wiktionaryEtymologyText).toBeNull();
  });
});
