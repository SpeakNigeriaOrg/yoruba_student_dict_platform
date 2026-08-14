// phraseSpelling.ts
//
// Whether a phrase is spelled the way its components are spelled - reported, never
// enforced.
//
// ---------------------------------------------------------------------------
// The rule this replaces, and why it was wrong
// ---------------------------------------------------------------------------
// A phrase used to have no spelling of its own: the Add Phrase tab built display_text
// by joining its components with spaces, and applyEtymologyDecision re-derived it from
// the components again on every etymology edit. So "a phrase is a sequence of words"
// had quietly become "a phrase's spelling is the concatenation of its words'
// spellings", which is a different and much stronger claim - one Wiktionary itself
// never makes. {{compound|yo|o|ṣeun}} asserts a derivation, not a string.
//
// Yoruba breaks the stronger claim constantly, and the corpus says so:
//
//   o ṣé      upstream's own head template gives canonical `o ṣé` (explicit_canonical_tag,
//             confidence 1.0) with IPA /ō ʃé/, while its parts are `o` + `ṣe`. Joining
//             the parts spells it `o ṣe`, at the wrong tone, and the tone grid then
//             teaches a volunteer to record that wrong tone.
//   muti      {{contraction|yo|mu|ọtí}} - two words, one written form, a vowel elided.
//   pẹjapẹja  {{reduplication|yo|pẹja|pẹja}} - joined without the space.
//
// Under the old rule none of these could be stored correctly, and 0017 closed the
// obvious workaround: minting a second word `ṣé` to hold the phrase's tone would be a
// second word citing `ṣe`'s etymology, which is two words claiming one identity.
//
// ---------------------------------------------------------------------------
// So the spelling is authored, and this is the check
// ---------------------------------------------------------------------------
// A mismatch is usually a real linguistic fact (elision, contraction, a tone change,
// a clipping) and occasionally a typo, and nothing in the data distinguishes them - so
// this warns and never blocks, exactly as the duplicate check does on the same screen.
// A curator seeing "this is not its parts joined" either knows why or has just caught
// their own mistake.

import { phraseTokens } from './phraseTokens.js';
import { formsEqualKey } from './toneMatching.js';

export interface PhraseSpellingCheck {
  /** True when the authored spelling is exactly the components joined by single spaces. */
  matches: boolean;
  /** What the components spell on their own - shown alongside the authored form, since
   * "these differ" is only useful next to what the other one says. */
  joined: string;
  /** Per-position comparison, as long as the longer of the two. A null on either side is
   * a word the other does not have, which is how a clipping and an added particle read. */
  words: Array<{ authored: string | null; component: string | null; same: boolean }>;
}

/** Compares an authored phrase spelling against its components' spellings.
 *
 * Comparison is by formsEqualKey (NFC + lowercase), the same key every other spelling
 * comparison in this codebase uses: an NFD `ọ` is a different string from an NFC `ọ` and
 * the same letter, and a capitalised first word of a phrase is not a spelling change.
 * Tone marks and underdots are NOT normalised away - they are the whole point, since a
 * tone difference between `ṣe` and `ṣé` is exactly the fact worth reporting. */
export function checkPhraseSpelling(displayText: string, componentSpellings: string[]): PhraseSpellingCheck {
  const authored = phraseTokens(displayText);
  const parts = componentSpellings.flatMap((spelling) => phraseTokens(spelling));
  const joined = parts.join(' ');

  const words: PhraseSpellingCheck['words'] = [];
  for (let i = 0; i < Math.max(authored.length, parts.length); i += 1) {
    const a = authored[i] ?? null;
    const c = parts[i] ?? null;
    words.push({ authored: a, component: c, same: a !== null && c !== null && formsEqualKey(a) === formsEqualKey(c) });
  }

  return { matches: words.length > 0 && words.every((w) => w.same), joined, words };
}

/** One sentence naming what differs, or null when nothing does.
 *
 * Written once here rather than in each caller: the Add Phrase tab, the etymology axis
 * and the Wiktionary export all want to say the same thing, and three phrasings of one
 * finding read as three different findings. */
export function describePhraseSpelling(check: PhraseSpellingCheck): string | null {
  if (check.matches) return null;
  const changed = check.words.filter((w) => !w.same);
  const respelt = changed.filter((w) => w.authored !== null && w.component !== null);
  const missing = changed.filter((w) => w.authored === null);
  const extra = changed.filter((w) => w.component === null);

  const parts: string[] = [];
  if (respelt.length > 0) {
    parts.push(respelt.map((w) => `${w.component} is written ${w.authored} here`).join(', '));
  }
  if (missing.length > 0) {
    parts.push(`${missing.map((w) => w.component).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not written out`);
  }
  if (extra.length > 0) {
    parts.push(`${extra.map((w) => w.authored).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not one of the components`);
  }
  return parts.join('; ');
}
