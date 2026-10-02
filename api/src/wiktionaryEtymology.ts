// wiktionaryEtymology.ts
//
// The etymology text of each word's cited Wiktionary entry - what its editors wrote about where the
// word comes from, in their own words.
//
// Shown wherever a word's etymology is, beside the structured parts, because the parts alone miss
// two things (counted 2026-10-02): 1,756 of the corpus's etymologies have this text and no
// structured breakdown at all, so a screen showing only parts showed nothing for them; and where
// there are parts, the text is the reasoning behind them ("Contraction of sọ + ọ̀rọ̀, literally
// 'to say words'").
//
// Read from the current corpus by the citation's entry_id, the same source the etymology review
// reads - not the pin, which is a snapshot from when the citation was validated.

import type { Queryable } from './db.js';

/** word_id -> its cited entry's etymology text, for the words that have one. */
export async function loadWiktionaryEtymologyTexts(client: Queryable, wordIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (wordIds.length === 0) return out;
  const { rows } = await client.query<{ word_id: string; etymology_text: string }>(
    `select distinct on (c.word_id) c.word_id, s.etymology_text
       from upstream_citations c
       join kaikki_senses s on s.entry_id = c.entry_id
      where c.word_id = any($1) and nullif(btrim(s.etymology_text), '') is not null
      order by c.word_id`,
    [[...new Set(wordIds)]],
  );
  for (const r of rows) out.set(r.word_id, r.etymology_text);
  return out;
}

export async function loadWiktionaryEtymologyText(client: Queryable, wordId: string): Promise<string | null> {
  return (await loadWiktionaryEtymologyTexts(client, [wordId])).get(wordId) ?? null;
}
