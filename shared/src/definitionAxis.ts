// definitionAxis.ts
//
// Port of generate_diagnostics.py's definition axis: resolve_definition_
// source (which Kaikki record's glosses source this word's definition - a
// MEANING LINK, independent of which record the spelling axis compares
// against) and check_definition (tracks whether a human has reviewed
// vocab.json's "definition" field, the third axis alongside spelling and
// etymology). Never writes to golden_record itself - only reports.

import { orthographyInsensitiveForm } from './orthography.js';
import { ALTERNATIVE_FORM_PATTERN, escapeRegExp, findCandidateByForm, isAlternativeFormOnly } from './diagnoseEntry.js';
import type { DiagnoseOverride, KaikkiLexicon, VocabEntry } from './types.js';

/** A candidate's glosses, minus any bare "alternative form of X"
 * cross-reference lines. A record can legitimately mix genuine senses with
 * a bundled alt-of sense, so whole-record isAlternativeFormOnly would wave
 * this through as "real" without checking whether the SPECIFIC gloss that
 * ends up used is the cross-reference line. */
export function realGlosses(glosses: string[]): string[] {
  return glosses.filter((g) => !ALTERNATIVE_FORM_PATTERN.test(g.trim()));
}

/** The specific gloss (not just the first one) that actually contains the
 * englishHint - a candidate's glosses often bundle every sense of a
 * polysemous word together, and the hint is what picked the right SENSE in
 * the first place. Blindly taking glosses[0] as a definition can silently
 * pick the wrong sense. */
export function findHintMatchingGloss(hint: string, glosses: string[]): string | null {
  if (!hint) return null;
  const pattern = new RegExp('\\b' + escapeRegExp(hint) + '\\b', 'i');
  return glosses.find((g) => pattern.test(g)) ?? null;
}

/** What Kaikki would suggest as this word's definition, independent of
 * whether vocab.json already has one - lets the resolver always show
 * "here's what we'd propose" even for an empty definition, without ever
 * writing it unprompted. */
export function proposeDefinition(hint: string, matchedGlosses: string[] | null | undefined): string | null {
  if (!matchedGlosses || matchedGlosses.length === 0 || isAlternativeFormOnly({ glosses: matchedGlosses })) {
    return null;
  }
  return findHintMatchingGloss(hint, matchedGlosses) ?? matchedGlosses[0];
}

export interface ResolvedDefinitionSource {
  glosses: string[];
  sourceForm: string | null;
  isCrossReference: boolean;
  note: string | null;
}

/** Decides which Kaikki record's glosses source this word's definition. A
 * cross-reference record's own glosses are never real content (always
 * "alternative form of X") - by default, follow a single, unambiguous
 * altOfTarget to its own record and use ITS glosses instead, one hop only.
 * A human can always override with an explicit definitionSourceForm,
 * bypassing this automatic resolution entirely, for ANY word - not just
 * cross-reference ones. */
export function resolveDefinitionSource(
  matchedForm: string | null | undefined,
  matchedGlosses: string[] | null | undefined,
  altOfTargets: string[] | null | undefined,
  lexicon: KaikkiLexicon,
  override?: DiagnoseOverride | null,
): ResolvedDefinitionSource {
  const ov = override ?? {};
  const explicitForm = ov.definitionSourceForm;
  const normalizedMatchedForm = matchedForm ?? null;

  if (explicitForm) {
    const allSenses = Object.values(lexicon).flat();
    const found = findCandidateByForm(allSenses, explicitForm);
    if (found) {
      const rg = realGlosses(found.glosses);
      return {
        glosses: rg.length > 0 ? rg : found.glosses,
        sourceForm: explicitForm,
        isCrossReference: isAlternativeFormOnly(found),
        note: null,
      };
    }
    // Explicit override didn't resolve (typo) - surface it rather than
    // silently ignoring, same principle as an unresolved candidateForm.
    return {
      glosses: matchedGlosses ?? [],
      sourceForm: normalizedMatchedForm,
      isCrossReference: false,
      note: `definitionSourceForm '${explicitForm}' not found in the lexicon - check for a typo.`,
    };
  }

  if (!matchedGlosses || matchedGlosses.length === 0) {
    return { glosses: [], sourceForm: normalizedMatchedForm, isCrossReference: false, note: null };
  }

  const isCrossRef = isAlternativeFormOnly({ glosses: matchedGlosses });
  if (!isCrossRef) {
    return { glosses: matchedGlosses, sourceForm: normalizedMatchedForm, isCrossReference: false, note: null };
  }

  const targets = altOfTargets ?? [];
  if (targets.length !== 1) {
    const note =
      targets.length > 1
        ? `This word matches a Kaikki cross-reference with multiple possible targets (${targets.join(', ')}) - search manually to pick the right one.`
        : null;
    return { glosses: matchedGlosses, sourceForm: normalizedMatchedForm, isCrossReference: true, note };
  }

  const targetWord = targets[0];
  const targetKey = orthographyInsensitiveForm(targetWord);
  const targetCandidates = lexicon[targetKey] ?? [];
  const realCandidates = targetCandidates.filter((c) => realGlosses(c.glosses).length > 0);

  if (realCandidates.length === 1) {
    const target = realCandidates[0];
    return {
      glosses: realGlosses(target.glosses),
      sourceForm: target.canonicalForm.value,
      isCrossReference: false,
      note: `Definition redirected from a Kaikki cross-reference ("alternative form of ${targetWord}") to its real entry.`,
    };
  }

  return {
    glosses: matchedGlosses,
    sourceForm: normalizedMatchedForm,
    isCrossReference: true,
    note: `This word matches a Kaikki cross-reference ("alternative form of ${targetWord}") that couldn't be auto-resolved to exactly one real entry - search manually to link it properly.`,
  };
}

export type DefinitionStatus = 'confirmed' | 'invalid_override' | 'pending_custom' | 'missing' | 'proposed';

export interface CheckDefinitionResult {
  definitionCandidateGlosses: string[];
  definitionSourceForm: string | null;
  definitionSourceIsCrossReference: boolean;
  definitionLinkedSameAsSpelling: boolean;
  definitionStatus: DefinitionStatus;
  definitionCurrent: string | null;
  definitionProposed?: string | null;
  definitionNote?: string;
}

/** Tracks whether a human has reviewed vocab.json's "definition" field - a
 * third axis, independent of the Kaikki-text and syllable-split axes,
 * decided via definitionAction: "confirm" (permanent) or "custom" (a
 * pending human-authored replacement). Never writes to golden_record
 * itself - only reports. */
export function checkDefinition(
  entry: VocabEntry,
  hint: string,
  glosses: string[] | null | undefined,
  override?: DiagnoseOverride | null,
  sourceForm?: string | null,
  sourceIsCrossReference = false,
  linkedSameAsSpelling = true,
  redirectNote?: string | null,
): CheckDefinitionResult {
  const ov = override ?? {};
  const action = ov.definitionAction;
  const current = entry.definition ?? null;
  const proposed = proposeDefinition(hint, glosses);
  const notes: string[] = redirectNote ? [redirectNote] : [];

  const base = {
    definitionCandidateGlosses: glosses ?? [],
    definitionSourceForm: sourceForm ?? null,
    definitionSourceIsCrossReference: sourceIsCrossReference,
    definitionLinkedSameAsSpelling: linkedSameAsSpelling,
  };

  function finish(
    statusFields: { definitionStatus: DefinitionStatus; definitionCurrent: string | null } & Partial<CheckDefinitionResult>,
    extraNote?: string,
  ): CheckDefinitionResult {
    if (extraNote) notes.push(extraNote);
    const result: CheckDefinitionResult = { ...base, ...statusFields };
    if (notes.length > 0) result.definitionNote = notes.join(' ');
    return result;
  }

  if (action === 'confirm') {
    return finish({ definitionStatus: 'confirmed', definitionCurrent: current });
  }

  if (action === 'custom') {
    const pendingText = ov.definitionText;
    if (pendingText === null || pendingText === undefined) {
      // Only reachable via a hand-edited overrides file - the UI always
      // pairs definitionAction with definitionText.
      return finish(
        { definitionStatus: 'invalid_override', definitionCurrent: current },
        "definitionAction is 'custom' but no definitionText is set - check dictionary_overrides.json for a typo.",
      );
    }
    if (current === pendingText) {
      // apply_definitions.py should have converted this override to
      // definitionAction: "confirm" once applied - if it's still "custom"
      // and already matches, it's stale bookkeeping.
      return finish(
        { definitionStatus: 'confirmed', definitionCurrent: current },
        'custom override is now stale - vocab.json already matches definitionText; safe to simplify to definitionAction: confirm.',
      );
    }
    return finish({
      definitionStatus: 'pending_custom',
      definitionCurrent: current,
      definitionProposed: pendingText,
    });
  }

  return finish({
    definitionStatus: !current && !proposed ? 'missing' : 'proposed',
    definitionCurrent: current,
    definitionProposed: proposed,
  });
}
