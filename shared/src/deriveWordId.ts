// deriveWordId.ts
//
// The word_id a requested word will be created under, derived from the Wiktionary etymology
// it cites.
//
// ---------------------------------------------------------------------------
// Why it has to be deterministic
// ---------------------------------------------------------------------------
// A volunteer building an etymology can name a component that is not in the dictionary yet.
// Their submission points at the word_id the request WILL create, and the link resolves when
// a curator approves it - no rewriting, no reconciliation pass.
//
// That only works if two volunteers who pick the same etymology derive the SAME id. Otherwise
// each would reference their own invented id, and the consensus tally would score two people
// who agree as being in conflict. So the id is a pure function of the etymology, never of who
// asked or when.
//
// ---------------------------------------------------------------------------
// This is production's existing convention, not a new scheme
// ---------------------------------------------------------------------------
// Measured against the real vocabulary: `orthographyInsensitiveForm` of the spelling plus a
// slug of the meaning is exactly how production already disambiguates words whose stripped
// spellings collide -
//
//     ewa_beans   èwà        ose_soap   ọṣẹ
//     ewa_beauty  ẹwà        oba_king   ọba
//
// The underdot is stripped (that is what orthographyInsensitiveForm does) and the MEANING
// carries the distinction. `èwà` and `ẹwà` are different words with the same stripped base,
// and the hint is what tells them apart. Add Word already prefills this shape for curators.
//
// ---------------------------------------------------------------------------
// Residual collisions, measured and accepted
// ---------------------------------------------------------------------------
// About 2% of the 6272 corpus entries derive an id that another entry also derives, and they
// are almost entirely Wiktionary's letter-name entries (`a`/`A`, `f`/`F`, `y`/`Y` - "the first
// letter of the Yoruba alphabet"), which are never parts of a compound. Appending a token from
// the entry id does NOT fix it, because case-pair entries share the same suffix, and it would
// uglify 262 ids to no purpose.
//
// So the collision is handled where it can be handled properly - at request time, against
// production, by resolveOrRequestComponent.ts, which appends a discriminator only when the id
// is genuinely taken by a word citing a DIFFERENT etymology. That stays deterministic because
// both volunteers see the same production state.

import { orthographyInsensitiveForm } from './orthography.js';

/** A slug of the word's meaning, from its first gloss.
 *
 * The first clause only: Kaikki glosses run long ("a type of long-necked bird with a crest;
 * black crowned crane; giraffe") and the id needs the head of it, which is also what a human
 * would have typed as the hint. */
export function meaningSlug(gloss: string | undefined): string {
  if (!gloss) return '';
  return gloss
    .split(/[,;(]/)[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The base id for a spelling and a meaning. Spaces become underscores so a multi-word
 * Wiktionary form (`ilẹ̀ Faran̄sé`) yields a usable id rather than one with a space in it. */
export function deriveWordId(displayText: string, gloss: string | undefined): string {
  const base = orthographyInsensitiveForm(displayText).replace(/\s+/g, '_');
  const meaning = meaningSlug(gloss);
  // No meaning to slug (15 of 6272 entries, all glossless) - the base alone is still a valid
  // id, and a curator seeing `a` in the request queue will know to fix it. Better than
  // inventing a suffix that means nothing.
  return meaning ? `${base}_${meaning}` : base;
}

/** Appends a stable token from the cited entry id, for the one case that needs it: the derived
 * id is already taken by a word citing a DIFFERENT etymology. Deterministic per etymology, so
 * two volunteers requesting the same word still agree. */
export function discriminateWordId(baseId: string, entryId: string): string {
  const token = entryId.split('-').pop() ?? entryId;
  return `${baseId}_${token.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/** The last resort, and it is needed: `discriminateWordId` is NOT always enough.
 *
 * Measured against the real corpus: 123 derived ids are shared by more than one etymology (262
 * entries, 4.2%), and for 63 of those entries the entry-id token above is identical too - they
 * are case pairs like `a`/`A` ("the first letter of the Yoruba alphabet"), whose ids differ only
 * in a character this function lowercases away.
 *
 * Without a third rung, two DIFFERENT etymologies could be requested under one word_id, and a
 * volunteer's component reference would then be ambiguous about which one it meant. That is
 * precisely the ambiguity words-enter-at-etymology-N exists to remove, so it cannot be left to
 * the tail of a distribution.
 *
 * FNV-1a over the whole entry id: deterministic, dependency-free (`shared` is bundled for the
 * browser, so no `node:crypto`), and case-sensitive, which is the distinction being lost. The id
 * it produces is ugly; it is also reached only by Wiktionary letter-name and pronoun entries that
 * are never parts of a compound. */
export function hashDiscriminateWordId(baseId: string, entryId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < entryId.length; i += 1) {
    hash ^= entryId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${baseId}_${hash.toString(16).padStart(8, '0')}`;
}
