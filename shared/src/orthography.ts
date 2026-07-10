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
