// componentsAxis.ts
//
// Port of generate_diagnostics.py's etymology/components axis:
// build_vocab_spelling_index, build_component_owners_index,
// preview_glosses_for_form, and components_axis_fields. Resolves each
// entry's Kaikki-proposed decomposition (from diagnoseEntry's
// matchedComponentCandidates) against golden_record's own word_ids, and
// builds the reverse index (which other entries list THIS entry as a
// component).

import { realGlosses } from './definitionAxis.js';
import { orthographyInsensitiveForm, toneInsensitiveForm } from './orthography.js';
import { classifyAgainstForms, formsEqualKey, STATUS_RANK, type ToneMatchStatus } from './toneMatching.js';
import type { ComponentCandidate, DiagnosticsOverrides, KaikkiLexicon, KaikkiSense, Vocab } from './types.js';

function pushToMap(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export interface VocabSpellingIndex {
  byDisplayText: Map<string, string[]>;
  byToneInsensitive: Map<string, string[]>;
}

/** word displayText (NFC+lowercased) / tone-insensitive spelling -> [word_id,
 * ...]. Only the EXACT-spelling index is ever used to confidently resolve a
 * component candidate to a specific word_id - tone is just as
 * meaning-bearing as an underdot in Yoruba, so a tone-insensitive match is
 * surfaced as a "possibly the same word" hint (possibleMatches below),
 * never auto-resolved. */
export function buildVocabSpellingIndex(vocab: Vocab): VocabSpellingIndex {
  const byDisplayText = new Map<string, string[]>();
  const byToneInsensitive = new Map<string, string[]>();
  for (const [wordId, entry] of Object.entries(vocab)) {
    pushToMap(byDisplayText, formsEqualKey(entry.displayText), wordId);
    pushToMap(byToneInsensitive, toneInsensitiveForm(entry.displayText), wordId);
  }
  return { byDisplayText, byToneInsensitive };
}

/** component word_id -> [owner word_id, ...] - the reverse of every entry's
 * own `components` list, skipping the trivial self-reference. */
export function buildComponentOwnersIndex(vocab: Vocab): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [wordId, entry] of Object.entries(vocab)) {
    for (const compId of entry.components ?? []) {
      if (compId !== wordId) {
        pushToMap(owners, compId, wordId);
      }
    }
  }
  return owners;
}

export interface PreviewGlossesForForm {
  glosses: string[];
  isExactMatch: boolean;
}

/** Gloss preview(s) for a Kaikki spelling that isn't confidently resolved
 * to a vocab word yet. Grades every candidate sense sharing this base
 * spelling by tonal closeness to the exact form given, rather than
 * requiring an exact string match. Returns EVERY candidate tied at the
 * best tier found (isExactMatch distinguishes a genuine homograph from
 * "no candidate actually matches this spelling, these are just the
 * closest coincidental neighbors"). */
export function previewGlossesForForm(form: string, lexicon: KaikkiLexicon): PreviewGlossesForForm {
  const candidates = lexicon[orthographyInsensitiveForm(form)] ?? [];
  if (candidates.length === 0) return { glosses: [], isExactMatch: false };

  const scored: Array<{ status: ToneMatchStatus; candidate: KaikkiSense }> = [];
  let bestStatus: ToneMatchStatus | null = null;
  for (const c of candidates) {
    const forms = c.standardForms && c.standardForms.length > 0 ? c.standardForms : [c.canonicalForm.value];
    const { status } = classifyAgainstForms(form, forms);
    scored.push({ status, candidate: c });
    if (bestStatus === null || STATUS_RANK[status] < STATUS_RANK[bestStatus]) {
      bestStatus = status;
    }
  }

  // Only the first real gloss of each tied candidate is ever considered
  // (matching generate_diagnostics.py's preview_glosses_for_form exactly),
  // added once if it isn't already collected - not every real gloss of
  // every tied candidate.
  const glosses: string[] = [];
  for (const { status, candidate } of scored) {
    if (status !== bestStatus) continue;
    const rg = realGlosses(candidate.glosses);
    if (rg.length > 0 && !glosses.includes(rg[0])) {
      glosses.push(rg[0]);
    }
  }
  return { glosses, isExactMatch: bestStatus === 'match' };
}

export interface ComponentsProposalItem {
  kaikkiForm: string;
  wordId: string | null;
  targetSpellingConfirmed: boolean;
  ambiguous: boolean;
  possibleMatches: string[];
  provenance: string;
  previewGlosses: string[];
  previewGlossesAreExactMatches: boolean;
}

export interface ComponentsAxisFieldsResult {
  componentsProposal: ComponentsProposalItem[];
  usedAsComponentOf: string[];
  components: string[];
  invalidComponents?: string[];
}

/** componentsProposal (this entry's Kaikki-proposed decomposition,
 * resolved against golden_record), usedAsComponentOf (the reverse index),
 * and invalidComponents (a dangling component reference) - the full set of
 * etymology/components-axis fields for one entry. */
export function componentsAxisFields(
  wordId: string,
  vocab: Vocab,
  matchedComponentCandidates: ComponentCandidate[] | null | undefined,
  lexicon: KaikkiLexicon,
  overrides: DiagnosticsOverrides,
  index: VocabSpellingIndex,
  componentOwners: Map<string, string[]>,
): ComponentsAxisFieldsResult {
  const proposal: ComponentsProposalItem[] = [];
  for (const candidate of matchedComponentCandidates ?? []) {
    const kaikkiForm = candidate.form;

    // Exact spelling only counts as a confident resolution - a
    // tone-insensitive coincidence is surfaced as possibleMatches instead:
    // a hint for a human to look at and decide, never auto-accepted.
    const exactMatches = index.byDisplayText.get(formsEqualKey(kaikkiForm)) ?? [];
    const wordIdMatch = exactMatches.length === 1 ? exactMatches[0] : null;
    const possibleMatches =
      exactMatches.length > 0 ? [] : (index.byToneInsensitive.get(toneInsensitiveForm(kaikkiForm)) ?? []);

    // An exact match against a word whose OWN spelling hasn't been
    // confirmed yet is only as trustworthy as "matches whatever we
    // currently have written down" - not the same confidence as matching
    // an already-vetted word.
    const targetConfirmed = wordIdMatch !== null && Boolean((overrides[wordIdMatch] ?? {}).action);

    let previewGlosses: string[];
    let previewGlossesAreExactMatches: boolean;
    if (wordIdMatch && targetConfirmed) {
      // Once it's a real, spelling-confirmed vocab word its own definition
      // axis is the source of truth, not a Kaikki gloss preview.
      previewGlosses = [];
      previewGlossesAreExactMatches = false;
    } else {
      const preview = previewGlossesForForm(kaikkiForm, lexicon);
      previewGlosses = preview.glosses;
      previewGlossesAreExactMatches = preview.isExactMatch;
    }

    proposal.push({
      kaikkiForm,
      wordId: wordIdMatch,
      targetSpellingConfirmed: targetConfirmed,
      ambiguous: exactMatches.length > 1,
      possibleMatches,
      provenance: candidate.provenance,
      previewGlosses,
      previewGlossesAreExactMatches,
    });
  }

  const entry = vocab[wordId];
  const ownComponents = entry.components ?? [];
  const fields: ComponentsAxisFieldsResult = {
    componentsProposal: proposal,
    usedAsComponentOf: componentOwners.get(wordId) ?? [],
    components: ownComponents.length > 0 ? ownComponents : [wordId],
  };
  const missing = ownComponents.filter((c) => !(c in vocab));
  if (missing.length > 0) {
    fields.invalidComponents = missing;
  }
  return fields;
}
