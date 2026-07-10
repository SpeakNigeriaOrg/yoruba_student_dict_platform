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

function isBaseN(grapheme: string): boolean {
  return extractBaseCharacter(grapheme) === 'n';
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
        if (isBaseN(nextG) && !hasToneMark(nextG)) {
          const nextAfterN = i + 2 < n ? graphemes[i + 2] : null;
          if (nextAfterN === null || !isVowel(nextAfterN)) {
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
