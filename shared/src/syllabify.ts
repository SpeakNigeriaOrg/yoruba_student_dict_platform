// syllabify.ts
//
// Port of yoruba-student-dict/scripts/syllabify.py - kept structurally
// identical (same variable names, same two-stage grapheme-grouping +
// CV-syllabification shape) rather than rewritten "more idiomatically", so
// a side-by-side diff against the Python original stays meaningful. See
// that file's own docstring for the algorithm's rationale; this file only
// documents where the JS port needed to differ.
//
// Input is lowercased before processing - capitalization is an
// orthographic convention (proper nouns), not a phonological signal.

const VOWELS = new Set(['a', 'e', 'ẹ', 'i', 'o', 'ọ', 'u']);
const NASALS = new Set(['m', 'n']);

/** The one place the orthography writes a nasal CODA as `m` rather than `n`. */
const LABIALS = new Set(['b', 'p']);

const CONSONANTS = new Set([
  'b', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'p', 'r', 's', 'ṣ', 't', 'w', 'y',
]);

const ACUTE = '́';
const GRAVE = '̀';
const MACRON = '̄';
const UNDERDOT = '̣';
const COMBINING_MARKS = new Set([ACUTE, GRAVE, MACRON, UNDERDOT]);
const TONE_MARKS = new Set([ACUTE, GRAVE, MACRON]);

function extractBaseCharacter(grapheme: string): string {
  // Array.from, not grapheme[0], so this indexes by Unicode code point
  // like Python's str indexing does - matters if a grapheme ever started
  // with an astral character (none expected in Yoruba text, but this is
  // the faithful equivalent rather than an assumption).
  return grapheme.length ? Array.from(grapheme)[0] : '';
}

function isVowel(grapheme: string): boolean {
  return VOWELS.has(extractBaseCharacter(grapheme));
}

function isNasal(grapheme: string): boolean {
  return NASALS.has(extractBaseCharacter(grapheme));
}

function isConsonant(grapheme: string): boolean {
  return CONSONANTS.has(extractBaseCharacter(grapheme));
}

function isDigraphGb(grapheme: string): boolean {
  return Array.from(grapheme).slice(0, 2).join('') === 'gb';
}

function hasToneMark(grapheme: string): boolean {
  return Array.from(grapheme).some((c) => TONE_MARKS.has(c));
}

function hasApostrophe(grapheme: string): boolean {
  return grapheme.includes("'");
}

// ---------------------------------------------------------------------------
// Which vowels can carry a nasal coda, and which nasals can BE one
// ---------------------------------------------------------------------------
// Yoruba has three syllable types - CV, V and N (a syllabic nasal) - and only /n/ and /m/ can be
// syllabic. So a nasal after a vowel is one of two things, and the letters do not always say
// which: a CODA nasalising that vowel, or a syllable in its own right. The two predicates below
// are the cases where the letters DO say, so nobody is asked about them.
//
// NASALISABLE. Only a, ẹ, i, ọ, u nasalise; plain `e` and `o` cannot. A nasal after a plain e/o
// therefore cannot be a coda - it must be syllabic. Verified over the whole corpus: 0 of 5,580
// forms have an absorbed nasal after a plain e/o, and the vowels that do take one are exactly
// those five plus 27 dialectal ị/ụ spellings. The single production word this fires on is
// `àgùnfon`, whose stored split already reads `fọn` and whose upstream form is `àgùnfọn` - so it
// diagnoses a known typo rather than re-analysing a word.
//
// ABSORBABLE. The coda is written `n` in general but assimilates to `m` before b/p - the same
// homorganic rule that writes the SYLLABIC nasal as `m` there. So `m` before a labial is
// ambiguous exactly as `n` is elsewhere and must be absorbable, while `m` anywhere else is
// always its own syllable because no coda `m` is licensed there. Inert on everything we hold: 0
// corpus forms and 0 production words contain a bare `m` before any consonant, and all 17
// m+labial forms are tone-marked (Wiktionary's own IPA transcribes every one as a standalone /ŋ/
// syllable).
//
// These are predicates over the GRAPHEME, not character sets. Graphemes are built from NFD text,
// so `ẹ` is `e` + U+0323 and shares a base character with `e` - which is also why VOWELS' own
// 'ẹ'/'ọ' entries are dead weight, matching only via their plain bases.
//
// Sources: en.wikibooks.org/wiki/Yoruba/Pronunciation ("The letter m is also a nasal vowel.
// However, it is only used for the letters b and p"; e and o cannot be nasalised);
// wisc.pb.unizin.org/yorubadictionary (the vowel + n orthography for nasal vowels).

/** Can this vowel grapheme carry a nasal coda? a/i/u always; e/o only underdotted (ẹ/ọ). */
function isNasalisableVowel(grapheme: string): boolean {
  const base = extractBaseCharacter(grapheme);
  if (base === 'a' || base === 'i' || base === 'u') return true;
  if (base === 'e' || base === 'o') return grapheme.includes(UNDERDOT);
  return false;
}

/** Can this nasal be absorbed as a coda onto the vowel before it? A nasal carrying a tone mark
 * never can - the mark is precisely what says it is syllabic. */
function isAbsorbableNasal(grapheme: string, following: string | null): boolean {
  if (hasToneMark(grapheme)) return false;
  const base = extractBaseCharacter(grapheme);
  if (base === 'n') return true;
  if (base === 'm') return following !== null && LABIALS.has(extractBaseCharacter(following));
  return false;
}

export function groupIntoGraphemes(word: string): string[] {
  const normalized = Array.from(word.toLowerCase().normalize('NFD'));
  const graphemes: string[] = [];
  let current = '';
  let i = 0;
  const n = normalized.length;

  while (i < n) {
    const char = normalized[i];

    if (COMBINING_MARKS.has(char)) {
      current += char;
    } else if (char === "'" && current !== '') {
      const base = extractBaseCharacter(current);
      if (CONSONANTS.has(base) || NASALS.has(base)) {
        current += char;
      }
      // else: apostrophe after a vowel is dropped, per the Python
      // pseudocode (no handling is specified for that case).
    } else {
      if (current !== '') {
        if (char === 'b' && extractBaseCharacter(current) === 'g') {
          current += char;
        } else {
          graphemes.push(current);
          current = char;
        }
      } else {
        current = char;
      }
    }

    i += 1;
  }

  if (current !== '') graphemes.push(current);

  return graphemes;
}

export function syllabifyWord(word: string): string[] {
  const graphemes = groupIntoGraphemes(word);
  const syllables: string[] = [];
  let buffer = '';
  let i = 0;
  const n = graphemes.length;

  while (i < n) {
    const g = graphemes[i];

    if (isVowel(g)) {
      buffer += g;

      if (i + 1 < n) {
        const nextG = graphemes[i + 1];
        const nextAfterN = i + 2 < n ? graphemes[i + 2] : null;
        // A following vowel makes the nasal that vowel's ONSET, so there is nothing to absorb.
        // Otherwise absorb it as a coda - but only where both halves are licensed: the vowel must
        // be one that nasalises, and the nasal must be one that can be a coda in this position.
        // See the block above; each condition rules out a class the letters already decide.
        if (nextAfterN === null || !isVowel(nextAfterN)) {
          if (isNasalisableVowel(g) && isAbsorbableNasal(nextG, nextAfterN)) {
            buffer += nextG;
            i += 1;
          }
        }
      }

      syllables.push(buffer);
      buffer = '';
    } else if (isNasal(g)) {
      const isToned = hasToneMark(g);
      const isPreconsonantal = i + 1 < n && !isVowel(graphemes[i + 1]);

      if (isToned || isPreconsonantal) {
        if (buffer !== '') {
          syllables.push(buffer);
          buffer = '';
        }
        syllables.push(g);
      } else {
        buffer += g;
      }
    } else if (isConsonant(g) || isDigraphGb(g) || hasApostrophe(g)) {
      buffer += g;
    }

    i += 1;
  }

  if (buffer !== '') syllables.push(buffer);

  // Re-compose: graphemes were built from NFD text, but vocab.json's
  // hand-authored syllables are precomposed (NFC).
  return syllables.map((s) => s.normalize('NFC'));
}

/** Syllables as slices of the ORIGINAL text, preserving capitalization - or null when
 * the text cannot be represented as syllables at all.
 *
 * Two reasons this exists rather than callers using syllabifyWord directly:
 *
 * CASE. syllabifyWord lowercases on purpose (capitalization is orthographic, not
 * phonological), which is right for matching and for audio and wrong for an editor:
 * a reviewer looking at the month name `Agẹmọ` must not be shown `agẹmọ`, and must
 * certainly not save it back that way.
 *
 * LOSS. syllabifyWord silently drops any character it does not model - it only
 * accumulates vowels, nasals, consonants, `gb` and apostrophes. The real lexicon
 * contains Ajami (Arabic-script Yoruba) spellings, hyphenated forms like `gan-an`,
 * and interjections like `hà!`, all of which come back missing characters. A tone
 * editor built on that would rewrite `gan-an` to `ganan` the moment anyone touched
 * it, so this returns **null** for such text and the caller must refuse to edit it
 * rather than quietly mangling a word nobody was asked about.
 *
 * The slicing is sound because lowercasing Yoruba is length-preserving in NFC; the
 * same null is returned if that ever stops holding, rather than slicing at wrong
 * offsets. */
export function syllabifySpans(text: string): string[] | null {
  const source = text.normalize('NFC');
  const lowered = syllabifyWord(source);
  if (lowered.length === 0) return source.length === 0 ? [] : null;

  const chars = [...source];
  const totalFromSyllables = lowered.reduce((n, s) => n + [...s].length, 0);
  if (totalFromSyllables !== chars.length) return null;

  const spans: string[] = [];
  let at = 0;
  for (const syllable of lowered) {
    const length = [...syllable].length;
    spans.push(chars.slice(at, at + length).join(''));
    at += length;
  }
  // Belt and braces: the slices must reconstitute the input exactly, or the caller
  // gets null. This is the invariant every consumer depends on.
  return spans.join('') === source ? spans : null;
}
