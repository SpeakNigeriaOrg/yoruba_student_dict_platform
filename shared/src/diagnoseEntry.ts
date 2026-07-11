// diagnoseEntry.ts
//
// Port of generate_diagnostics.py's diagnose_entry and its supporting
// candidate-disambiguation helpers. Two genuinely separate problems, in two
// separate steps:
//   1. Disambiguation - a base spelling (tone/underdot stripped) can map to
//      several unrelated Kaikki senses. The English hint embedded in this
//      project's own word_id scheme (e.g. owo_hand -> "hand") picks the
//      right sense; this is where "confidence" applies, since it's a
//      meaning question, not a spelling one.
//   2. Tone comparison - only once step 1 confidently identifies a single
//      sense do we compare our own toned spelling against its canonical
//      toned form (via classifyAgainstForms from toneMatching.ts).
//
// See yoruba-student-dict/REMOTE_ACCESS_DISCUSSION.md §4 for the specific
// bugs this logic was built to fix.

import { orthographyInsensitiveForm } from './orthography.js';
import { classifyAgainstForms, formsEqual, type ToneMatchStatus } from './toneMatching.js';
import type { DiagnoseOverride, KaikkiLexicon, KaikkiSense, VocabEntry, ComponentCandidate } from './types.js';

export function deriveEnglishHint(wordId: string, displayText: string): string {
  const baseKey = orthographyInsensitiveForm(displayText).replace(/ /g, '_');
  const prefix = baseKey + '_';
  if (wordId.startsWith(prefix)) {
    return wordId.slice(prefix.length).replace(/_/g, ' ');
  }
  // Fallback if the id doesn't start with the expected base spelling - best
  // effort, and the entry gets flagged as low-confidence anyway.
  const idx = wordId.indexOf('_');
  return idx === -1 ? '' : wordId.slice(idx + 1).replace(/_/g, ' ');
}

export const ALTERNATIVE_FORM_PATTERN = /^alternative form of\b/i;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scoreCandidate(hint: string, candidate: KaikkiSense): number {
  if (!hint) return 0;
  const pattern = new RegExp('\\b' + escapeRegExp(hint) + '\\b', 'i');
  return candidate.glosses.reduce((sum, gloss) => sum + (pattern.test(gloss) ? 1 : 0), 0);
}

/** Kaikki's "alternative form of X" cross-reference entries always repeat
 * X's own gloss text, so they tie with X on keyword score every time. Used
 * to break that tie in favor of the primary entry. Takes just the glosses
 * (not a full KaikkiSense) so it also works on the ad-hoc "just the glosses
 * we matched against" case the definition axis needs. */
export function isAlternativeFormOnly(candidate: { glosses: string[] }): boolean {
  const glosses = candidate.glosses;
  return glosses.length > 0 && glosses.every((g) => ALTERNATIVE_FORM_PATTERN.test(g.trim()));
}

export function findCandidateByForm(candidates: KaikkiSense[], form: string): KaikkiSense | null {
  return candidates.find((c) => c.canonicalForm.value === form) ?? null;
}

const VOWEL_LETTERS = new Set(['a', 'e', 'ẹ', 'i', 'o', 'u', 'ọ']);

/** Collapses runs of the same vowel letter into one (e.g. "beelu" ->
 * "belu"). Deliberately NOT folded into orthography.ts's three-tier model -
 * that stays algorithmically identical to yoruba_orthography.py/orthography.mjs
 * on purpose, and vowel-doubling collapse is a looser, this-package-only
 * DISCOVERY heuristic, not a canonical normalization tier both need to
 * agree on. */
export function collapseRepeatedVowels(s: string): string {
  const result: string[] = [];
  let prev: string | null = null;
  for (const c of s) {
    if (c === prev && VOWEL_LETTERS.has(c)) continue;
    result.push(c);
    prev = c;
  }
  return result.join('');
}

/** Fallback for when the exact orthography-insensitive lookup finds
 * nothing: collapses repeated vowel letters and checks every lexicon key
 * the same way, surfacing near-miss spelling variants Kaikki might be filed
 * under instead. Kept deliberately narrow - any match found this way is
 * always routed through manual candidate confirmation, never auto-chosen,
 * even when it's the only one (see discoveredViaRelaxedMatch below). */
export function findRelaxedCandidates(lexicon: KaikkiLexicon, baseKey: string): KaikkiSense[] {
  const target = collapseRepeatedVowels(baseKey);
  if (target === baseKey) return [];
  const candidates: KaikkiSense[] = [];
  for (const [key, senses] of Object.entries(lexicon)) {
    if (key !== baseKey && collapseRepeatedVowels(key) === target) {
      candidates.push(...senses);
    }
  }
  return candidates;
}

export type DiagnoseStatus =
  | 'phrase'
  | 'skipped_multiword'
  | 'not_in_kaikki'
  | 'ambiguous_match'
  | ToneMatchStatus
  | 'matched_alternative_form'
  | 'verified_keep_ours'
  | 'decided_adopt_kaikki';

export interface CandidateConsidered {
  form: string;
  pos: string;
  glosses: string[];
}

export interface DiagnoseEntryResult {
  wordId: string;
  displayText: string;
  status: DiagnoseStatus;
  englishHint?: string;
  matchedForm?: string;
  canonicalForm?: string;
  adoptionTarget?: string;
  matchedPos?: string;
  matchedGlosses?: string[];
  matchedAltOfTargets?: string[];
  matchedComponentCandidates?: ComponentCandidate[];
  matchedUsedInCandidates?: ComponentCandidate[];
  resolvedBy?: 'manual_selection_via_search' | 'manual_selection' | 'keep_ours' | 'adopt_kaikki_pending';
  candidatesConsidered?: CandidateConsidered[];
  discoveredViaRelaxedMatch?: true;
  note?: string;
}

export function diagnoseEntry(
  wordId: string,
  entry: VocabEntry,
  lexicon: KaikkiLexicon,
  override?: DiagnoseOverride | null,
): DiagnoseEntryResult {
  const displayText = entry.displayText;
  const ov = override ?? {};

  if (entry.type === 'phrase') {
    // A phrase's components were picked deliberately by a human at
    // authoring time - there's no single-word Kaikki record to compare a
    // multi-token spelling against, so this skips the candidate-matching
    // machinery below entirely, same as skipped_multiword does for any
    // multi-word displayText.
    return applyOverride({ wordId, displayText, status: 'phrase' }, ov);
  }

  if (displayText.includes(' ')) {
    return applyOverride({ wordId, displayText, status: 'skipped_multiword' }, ov);
  }

  const hint = deriveEnglishHint(wordId, displayText);
  const baseKey = orthographyInsensitiveForm(displayText);
  let candidates = lexicon[baseKey] ?? [];
  let discoveredViaRelaxedMatch = false;

  if (candidates.length === 0) {
    candidates = findRelaxedCandidates(lexicon, baseKey);
    discoveredViaRelaxedMatch = candidates.length > 0;
  }

  let chosen: KaikkiSense | null = null;
  let manuallySelected = false;
  let foundViaSearch = false;

  // candidateForm pins WHICH Kaikki sense this word is being compared
  // against, independent of what should be done about that comparison
  // (action) - keying this on candidateForm alone (not requiring
  // action === 'select_candidate') is what lets a word both confirm a
  // Kaikki match AND still decide to keep our own spelling.
  if (ov.candidateForm) {
    chosen = findCandidateByForm(candidates, ov.candidateForm);
    if (chosen === null) {
      // Not among the automatically-detected candidates - it may have been
      // found via the resolver's free-form Kaikki search instead. Scan the
      // full lexicon before giving up.
      const allSenses = Object.values(lexicon).flat();
      chosen = findCandidateByForm(allSenses, ov.candidateForm);
      foundViaSearch = chosen !== null;
    }
    manuallySelected = chosen !== null;
    // Falls through to automatic selection below if the override's
    // candidateForm doesn't appear anywhere in the lexicon (e.g. a typo) -
    // better to surface the normal ambiguous_match/not_in_kaikki than
    // silently ignore it.
  }

  if (candidates.length === 0 && chosen === null) {
    return applyOverride({ wordId, displayText, englishHint: hint, status: 'not_in_kaikki' }, ov);
  }

  if (chosen === null && candidates.length === 1 && !discoveredViaRelaxedMatch) {
    chosen = candidates[0];
  } else if (chosen === null) {
    const scores = candidates.map((c) => scoreCandidate(hint, c));
    const top = Math.max(...scores);
    let topCandidates = candidates.filter((_, i) => scores[i] === top);

    if (top > 0 && topCandidates.length > 1) {
      const primary = topCandidates.filter((c) => !isAlternativeFormOnly(c));
      if (primary.length === 1) topCandidates = primary;
    }

    if (top > 0 && topCandidates.length > 1) {
      // If every still-tied candidate would produce the identical tone
      // verdict against our spelling, there's no real decision to make.
      // Only collapse the tie when it's a genuine non-issue; a real
      // semantic ambiguity (different verdicts) still needs a human.
      const tied = topCandidates.map((c) => {
        const forms = c.standardForms && c.standardForms.length > 0 ? c.standardForms : [c.canonicalForm.value];
        const { status, form } = classifyAgainstForms(displayText, forms);
        return { candidate: c, status, form };
      });
      const verdicts = new Set(tied.map((t) => t.status));
      if (verdicts.size === 1) {
        // Prefer (1) a non-cross-reference candidate, (2) one whose match
        // is direct against its own canonical form rather than one of its
        // alternatives - which tied candidate survives still matters even
        // though the verdict is the same.
        const nonReference = tied.filter((t) => !isAlternativeFormOnly(t.candidate));
        const pool = nonReference.length > 0 ? nonReference : tied;
        const direct = pool.filter((t) => formsEqual(t.form, t.candidate.canonicalForm.value));
        topCandidates = [(direct.length > 0 ? direct : pool)[0].candidate];
      }
    }

    // A relaxed-match discovery is always a guess, even with only one
    // candidate - unlike an exact-lookup single candidate (auto-chosen
    // above), it still needs a human to confirm it's the right word.
    if (top === 0 || topCandidates.length > 1 || discoveredViaRelaxedMatch) {
      const result: DiagnoseEntryResult = {
        wordId,
        displayText,
        englishHint: hint,
        status: 'ambiguous_match',
        candidatesConsidered: candidates.map((c) => ({ form: c.canonicalForm.value, pos: c.pos, glosses: c.glosses })),
      };
      if (discoveredViaRelaxedMatch) result.discoveredViaRelaxedMatch = true;
      return applyOverride(result, ov);
    }
    chosen = topCandidates[0];
  }

  const canonicalForm = chosen.canonicalForm.value;
  const hasRealCanonical = chosen.canonicalForm.inferenceMethod === 'explicit_canonical_tag';
  const standardForms = chosen.standardForms && chosen.standardForms.length > 0 ? chosen.standardForms : [canonicalForm];
  const classified = classifyAgainstForms(displayText, standardForms);
  const matchedForm = classified.form;
  let toneStatus: DiagnoseStatus = classified.status;

  // A clean tone match can still be worth a second look: if we match an
  // alternative-tagged spelling while Kaikki records a genuinely different,
  // explicitly-tagged canonical form, that's worth surfacing. If Kaikki has
  // no real canonical tag on record, matching any attested alternative is
  // fine and not worth flagging - there's no "better" spelling to prefer.
  if (toneStatus === 'match' && hasRealCanonical && !formsEqual(matchedForm, canonicalForm)) {
    toneStatus = 'matched_alternative_form';
  }

  // For a real tone/underdot mismatch, "adopt Kaikki's spelling" means the
  // closest attested form found. For matched_alternative_form, adopting
  // matchedForm would be a no-op - the meaningful upgrade is to the
  // canonical form instead.
  const adoptionTarget = toneStatus === 'matched_alternative_form' ? canonicalForm : matchedForm;

  const result: DiagnoseEntryResult = {
    wordId,
    displayText,
    englishHint: hint,
    status: toneStatus,
    matchedForm,
    canonicalForm,
    adoptionTarget,
    matchedPos: chosen.pos,
    matchedGlosses: chosen.glosses,
    matchedAltOfTargets: chosen.altOfTargets ?? [],
    matchedComponentCandidates: chosen.componentCandidates ?? [],
    matchedUsedInCandidates: chosen.usedInCandidates ?? [],
  };
  if (manuallySelected) {
    result.resolvedBy = foundViaSearch ? 'manual_selection_via_search' : 'manual_selection';
  }
  return applyOverride(result, ov);
}

export function applyOverride(result: DiagnoseEntryResult, override?: DiagnoseOverride | null): DiagnoseEntryResult {
  if (!override || Object.keys(override).length === 0) return result;

  if (override.note) {
    result.note = override.note;
  }

  // A candidateForm pin that didn't resolve to anything (typo, or a
  // spelling that isn't actually in the lexicon) is worth flagging
  // regardless of what action accompanies it.
  if (override.candidateForm && result.resolvedBy === undefined) {
    result.note = `${result.note ?? ''} [override candidateForm not found among candidates - check for a typo]`.trim();
  }

  const action = override.action;
  if (action === 'keep_ours') {
    result.status = 'verified_keep_ours';
    result.resolvedBy = 'keep_ours';
  } else if (action === 'adopt_kaikki') {
    if (result.status === 'match') {
      // vocab.json was already edited to match - the override is now stale
      // bookkeeping, safe to delete from the overrides file.
      result.note =
        `${result.note ?? ''} [adopt_kaikki override is now stale - vocab.json already matches Kaikki; safe to remove this entry from the overrides file]`.trim();
    } else {
      result.status = 'decided_adopt_kaikki';
      result.resolvedBy = 'adopt_kaikki_pending';
    }
  }
  // action === 'select_candidate' with no further action means "pinned,
  // not yet decided further" - if the pin succeeded, resolvedBy is already
  // set above; if it failed, the candidateForm check above already covers it.
  return result;
}
