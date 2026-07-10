// toneMatching.ts
//
// Port of generate_diagnostics.py's classify_tone_match/forms_equal/
// classify_against_forms - the core of the Kaikki-spelling-comparison axis.
// Tone and underdots are each independently meaning-bearing in Yoruba, not
// stylistic variation (see REMOTE_ACCESS_DISCUSSION.md §4) - this is the
// function that encodes that distinction: underdot_mismatch is treated as
// a more serious discrepancy than tone_mismatch, never collapsed together.

import { toneInsensitiveForm } from './orthography';

export type ToneMatchStatus = 'match' | 'tone_mismatch' | 'underdot_mismatch';

export function formsEqualKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

export function formsEqual(a: string, b: string): boolean {
  return formsEqualKey(a) === formsEqualKey(b);
}

export function classifyToneMatch(ourText: string, theirText: string): ToneMatchStatus {
  // NFC-normalize first: vocab.json and Kaikki don't always compose the
  // same grapheme the same way (e.g. "o" + combining-dot-below vs the
  // precomposed "ọ"), which is a pure encoding difference, not a tone or
  // spelling one. Lowercase too - proper-noun capitalization (month/place
  // names) is an orthographic convention, not a tone signal, and
  // conflating it with real tone mistakes would make this report noisy
  // and untrustworthy.
  const ourNorm = formsEqualKey(ourText);
  const theirNorm = formsEqualKey(theirText);
  if (ourNorm === theirNorm) return 'match';
  if (toneInsensitiveForm(ourNorm) === toneInsensitiveForm(theirNorm)) return 'tone_mismatch';
  return 'underdot_mismatch';
}

export const STATUS_RANK: Record<ToneMatchStatus, number> = {
  match: 0,
  tone_mismatch: 1,
  underdot_mismatch: 2,
};

export interface ClassifyAgainstFormsResult {
  status: ToneMatchStatus;
  form: string;
}

/** Compares against every standard-tagged spelling Kaikki has on record
 * for this sense (canonical AND alternatives), not just the canonical
 * form - a vocab entry spelled the common alternative way (e.g. "balùwẹ̀"
 * instead of the canonical-but-rarely-used "ibalùwẹ̀") shouldn't be
 * reported as a spelling mismatch just because it doesn't match whichever
 * form happens to be tagged canonical. */
export function classifyAgainstForms(ourText: string, theirForms: string[]): ClassifyAgainstFormsResult {
  let bestStatus: ToneMatchStatus = 'underdot_mismatch';
  let bestForm = theirForms[0];

  for (const form of theirForms) {
    const status = classifyToneMatch(ourText, form);
    if (STATUS_RANK[status] < STATUS_RANK[bestStatus]) {
      bestStatus = status;
      bestForm = form;
      if (bestStatus === 'match') break;
    }
  }

  return { status: bestStatus, form: bestForm };
}
