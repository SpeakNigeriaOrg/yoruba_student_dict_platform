// orthography.ts
//
// This is close to a direct port of yorubadict's own build/lib/orthography.mjs,
// not a fresh translation - see REMOTE_ACCESS_DISCUSSION.md. yoruba-student-dict's
// scripts/yoruba_orthography.py is ITSELF a deliberate Python port of that same
// file, kept algorithmically identical on purpose; this is the third leg of the
// same triangle (JS platform / Python offline pipeline / this JS platform again,
// completing the loop back to the original). Verified against the exact same
// combining-mark codepoints as yoruba_orthography.py so the two never quietly
// drift apart.
//
// Yoruba orthography has three independent dimensions:
//   - base letters
//   - underdots (ẹ ọ ṣ - vowel/consonant quality)
//   - tone marks (grave à, acute á, macron/mid ā)
//
// Three normalized forms per string:
//   exact                   - untouched, as written
//   toneInsensitive         - tone marks stripped, underdots preserved
//   orthographyInsensitive  - tone marks AND underdots stripped, lowercased

export const TONE_MARKS = new Set(['̀', '́', '̂', '̄']); // grave, acute, circumflex, macron
export const UNDERDOT_MARKS = new Set(['̣', '̇']); // dot below (ẹ ọ), dot above (ṣ)

export function exactForm(s: string): string {
  return s;
}

function stripMarks(s: string, marksToStrip: Set<string>): string {
  const decomposed = s.normalize('NFD');
  let kept = '';
  for (const c of decomposed) {
    if (!marksToStrip.has(c)) kept += c;
  }
  return kept.normalize('NFC');
}

export function toneInsensitiveForm(s: string): string {
  return stripMarks(s, TONE_MARKS).toLowerCase();
}

export function orthographyInsensitiveForm(s: string): string {
  return stripMarks(s, new Set([...TONE_MARKS, ...UNDERDOT_MARKS])).toLowerCase();
}

/** The Wiktionary page title for a spelling, per that project's Yoruba policy:
 *
 *   "The underdot vowels, ẹ and ọ, should be used in page titles, but the tones should be
 *    marked in the headword line. [...] The consonant ṣ should also be used in page titles."
 *
 * So a title keeps ẹ, ọ and ṣ and loses every tone mark, including the macron - a macron marks
 * an ambiguous mid-tone nasal, which is a tone, and the policy puts tones in the headword line.
 *
 *     ọwọ́      -> ọwọ
 *     gban̄gba  -> gbangba
 *     Ṣóyínká   -> Ṣoyinka
 *
 * Which is toneInsensitiveForm, except for the case: that function lowercases, because it exists
 * to build a lookup KEY where case is noise. A page title is a name, and `Ṣóyínká` is a person,
 * so lowercasing it would produce the wrong page. Hence a separate function rather than a flag -
 * the two have different jobs and one of them must never be used for the other.
 *
 * NOT a filename or a storage key. Anything a machine stores or fetches is built from the
 * `word_id`, which is ASCII by construction; this deliberately returns the special characters
 * because the policy requires them. */
export function wiktionaryPageTitle(s: string): string {
  return stripMarks(s, TONE_MARKS);
}

export interface AllForms {
  exact: string;
  toneInsensitive: string;
  orthographyInsensitive: string;
}

export function allForms(s: string): AllForms {
  return {
    exact: exactForm(s),
    toneInsensitive: toneInsensitiveForm(s),
    orthographyInsensitive: orthographyInsensitiveForm(s),
  };
}
