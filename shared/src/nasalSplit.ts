// nasalSplit.ts
//
// Flipping the one syllable boundary the letters cannot settle.
//
// ---------------------------------------------------------------------------
// What is actually ambiguous
// ---------------------------------------------------------------------------
// A nasal after a vowel is either a CODA nasalising that vowel or a syllable of its own, and
// bare spelling does not always say which: `alangba` is `a·lan·gba` or `a·la·n·gba`.
// syllabify.ts settles two classes by rule - a nasal after plain `e`/`o` must be syllabic
// because those vowels do not nasalise, and `m` is only a coda before `b`/`p` - and defaults the
// rest to coda, which agrees with Wiktionary's own IPA on 3,993 of 3,996 forms.
//
// That default is right far more often than not, but it was previously the ONLY reachable
// answer. Tone goes on a syllable's vowel when it has one (see tone.ts's toneBearerKind), so the
// three buttons over `lan` write `làn`/`lan`/`lán` and never touch the `n`: there was no
// sequence of taps that reached `aláǹgbá`. These two functions are that missing move.
//
// ---------------------------------------------------------------------------
// Making a nasal syllabic IS marking it
// ---------------------------------------------------------------------------
// Freeing a nasal writes the macron on it, rather than leaving a bare boundary behind. That is
// not decoration - it is what makes the new split re-derivable from the new spelling:
//
//     alangba   a │ lan │ gba   ->   alan̄gba   a │ la │ n̄ │ gba
//
// and syllabifyWord('alan̄gba') returns exactly ['a','la','n̄','gba']. It has to, because nothing
// stores a boundary that the spelling does not imply: EntryReview seeds its rows from
// syllabifySpans(displayText), not from golden_record.syllables, and PhraseComposer holds only
// the composed text. A boundary nobody could re-derive would be invisible on the next load and
// silently overwritten.
//
// Absorbing is the mirror, and drops the nasal's tone mark - a coda carries no tone of its own,
// the vowel does. That makes the merge a visible spelling change, which is correct: it is a claim
// about the word, not a display preference.
//
// ---------------------------------------------------------------------------
// Why these verify themselves
// ---------------------------------------------------------------------------
// Each function builds its candidate and then RE-DERIVES it with syllabifyWord, returning null
// unless the result comes back identical. So the rules live in exactly one place. A flip cannot
// disagree with the splitter even if these functions are wrong about the orthography, and adding
// a rule to syllabify.ts automatically stops offering flips it has decided - which is the whole
// invariant the design rests on, enforced rather than remembered.
//
// They take the whole syllable array and an index, not one syllable, because the `m` case needs
// its right-hand neighbour: `jàm` alone does not absorb (no following labial) while `jàm` + `bá`
// does. ToneGrid already deals in whole arrays, so this costs its callers nothing.

import { syllabifyWord } from './syllabify.js';
import { applyToneExplicitly, lettersOf } from './tone.js';

/** Does this array of syllables reproduce itself when the joined word is re-split? Compared
 * lowercased, since syllabifyWord lowercases on purpose - capitalisation is orthographic, not
 * phonological, and the caller keeps the cased form. */
function roundTrips(syllables: string[]): boolean {
  const derived = syllabifyWord(syllables.join(''));
  if (derived.length !== syllables.length) return false;
  return derived.every((s, i) => s.normalize('NFC') === syllables[i].toLowerCase().normalize('NFC'));
}

/** The trailing bare nasal of a syllable, or null. Bare means carrying no tone mark: a marked
 * nasal is already syllabic, so there is nothing absorbed to free. */
function trailingBareNasal(syllable: string): { head: string; nasal: string } | null {
  const chars = [...syllable.normalize('NFD')];
  const last = chars[chars.length - 1];
  if (last === undefined) return null;
  if (last.toLowerCase() !== 'n' && last.toLowerCase() !== 'm') return null;
  const head = chars.slice(0, -1);
  if (head.length === 0) return null;
  return { head: head.join('').normalize('NFC'), nasal: last };
}

/** Is this syllable nothing but a nasal, with or without a tone mark? */
function isLoneNasal(syllable: string): boolean {
  const chars = [...syllable.normalize('NFD')];
  if (chars.length === 0) return false;
  const base = chars[0].toLowerCase();
  if (base !== 'n' && base !== 'm') return false;
  return chars.slice(1).every((c) => '̀́̄'.includes(c));
}

/** Refuses to operate on a split that does not already re-derive from its own text.
 *
 * `gan-an` is the case: the splitter models no hyphen, so it yields ['gan','an'] and joining those
 * gives `ganan`, which re-splits as ['ga','nan']. Flipping inside a split like that would produce
 * a third answer unrelated to either. The UI never asks - EntryReview refuses to edit a word at
 * all when syllabifySpans returns null, and hyphenated forms are exactly what it returns null for -
 * but a primitive that mangles `gan-an` when called directly is a trap for the next caller.
 *
 * Turning it away also means the round-trip guarantee holds unconditionally rather than only for
 * inputs someone remembered to check. */
function isSelfConsistent(syllables: string[]): boolean {
  return roundTrips(syllables);
}

/** True when `syllables[index]` ends in an absorbed nasal that could be freed - i.e. when the
 * ambiguity is live here and a reviewer has a real choice to make. */
export function canFreeNasal(syllables: string[], index: number): boolean {
  return freeNasalAt(syllables, index) !== null;
}

/** True when `syllables[index]` is a lone nasal that could be absorbed into its left neighbour. */
export function canAbsorbNasal(syllables: string[], index: number): boolean {
  return absorbNasalAt(syllables, index) !== null;
}

/** The syllables with `index`'s absorbed nasal freed into a syllable of its own, carrying an
 * explicit mid macron. Null when there is nothing to free, or when the result would not
 * re-derive - which is also how a rule in syllabify.ts silently withdraws the offer. */
export function freeNasalAt(syllables: string[], index: number): string[] | null {
  const syllable = syllables[index];
  if (syllable === undefined) return null;
  if (!isSelfConsistent(syllables)) return null;
  const parts = trailingBareNasal(syllable);
  if (parts === null) return null;

  // applyToneExplicitly, NOT applyTone: an unmarked `n` already reads as mid, so applyTone would
  // hand it back byte-identical and the new boundary would not survive a re-derive. Freeing a
  // nasal is a deliberate re-analysis, and the macron is how it is written down.
  const next = [...syllables];
  next.splice(index, 1, parts.head, applyToneExplicitly(parts.nasal, 'mid'));
  return roundTrips(next) ? next : null;
}

/** The syllables with the lone nasal at `index` absorbed into the syllable before it, losing its
 * tone mark. Null when there is no lone nasal there, nothing before it, or the result would not
 * re-derive - which is what refuses a coda the orthography does not license (an `m` before a
 * non-labial, or any nasal after a plain `e`/`o`). */
export function absorbNasalAt(syllables: string[], index: number): string[] | null {
  if (index <= 0) return null;
  const syllable = syllables[index];
  const previous = syllables[index - 1];
  if (syllable === undefined || previous === undefined) return null;
  if (!isLoneNasal(syllable)) return null;
  if (!isSelfConsistent(syllables)) return null;

  const merged = (previous + lettersOf(syllable)).normalize('NFC');
  const next = [...syllables];
  next.splice(index - 1, 2, merged);
  return roundTrips(next) ? next : null;
}
