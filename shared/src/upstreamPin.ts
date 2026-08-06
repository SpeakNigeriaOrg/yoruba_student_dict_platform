// upstreamPin.ts
//
// A student dictionary entry IS a Wiktionary etymology. This module holds the
// two things that makes safe:
//
//   1. buildPin - the COPY of the cited etymology taken at validation time, so
//      an entry renders and reasons with no live Kaikki lookup. Wiktionary can
//      change tomorrow without silently changing what we assert today.
//   2. pinContentFingerprint - the comparison key that detects it changing.
//
// See db/migrations/0014_upstream_sense_citations.sql for the storage side.

import { FIELD_SEP, LIST_SEP, NULL_MARKER, normalizeGloss, normalizeText } from './textFingerprint.js';
import { formsEqual } from './toneMatching.js';
import type { KaikkiSense } from './types.js';

/** The frozen copy of a cited etymology.
 *
 * Deliberately content ONLY - no entryId. The cited id lives in
 * upstream_citations.entry_id, which is the indexed, queryable column and the
 * single source of truth for "which etymology". A second copy inside the pin
 * could disagree with it, and there would be no way to tell which was right. */
export interface UpstreamPin {
  etymologyNumber: string | null;
  pos: string;
  canonicalForm: string;
  /** Ordered as upstream had them, because order carries meaning for DISPLAY:
   * the first gloss is the primary sense and seeds the student definition.
   *
   * Order carries no meaning for COMPARISON - see pinContentFingerprint. */
  glosses: string[];
  /** Wiktionary's free-text etymology prose. Pinned because it is part of what
   * a human read when they judged this the right etymology. */
  etymologyText: string | null;
}

/** Takes the copy. Call this at the moment a human picks an etymology, never
 * later - a pin taken later is a copy of a different corpus. */
export function buildPin(sense: KaikkiSense): UpstreamPin {
  return {
    etymologyNumber: sense.etymologyNumber,
    pos: sense.pos,
    canonicalForm: sense.canonicalForm.value,
    glosses: [...sense.glosses],
    etymologyText: sense.etymologyText ?? null,
  };
}

/** The drift key: equal fingerprints mean upstream still says what it said when
 * the citation was made.
 *
 * Glosses are compared as a SET (sorted), not in upstream's order. This is not
 * a convenience - it is required by how the id is derived. kaikki-yoruba mints
 * an entry's id from its FIRST sense's wiktextract id, and 20.7% of entries
 * have more than one sense. So a Wiktionary editor reordering senses INSIDE one
 * etymology moves our cited id while changing nothing about what the etymology
 * means. Comparing ordered glosses would report that as an upstream content
 * edit and send a curator to adjudicate a non-event.
 *
 * Adding, removing or rewording a gloss still changes the fingerprint, which is
 * the drift worth a human's attention. */
export function pinContentFingerprint(pin: UpstreamPin): string {
  return [
    'pin',
    pin.etymologyNumber === null ? NULL_MARKER : normalizeText(pin.etymologyNumber),
    normalizeText(pin.pos),
    normalizeText(pin.canonicalForm),
    pin.glosses.map(normalizeGloss).sort().join(LIST_SEP),
  ].join(FIELD_SEP);
}

/** etymologyText is excluded from the fingerprint above on purpose.
 *
 * It is prose a human read, not a claim we assert. Wiktionary copy-edits
 * etymology paragraphs constantly, and treating each one as drift would bury
 * the real signal - a changed gloss set - under noise nobody can action. It is
 * still pinned, so a curator looking at a real drift can see what the prose
 * said at validation time. */

/** kaikki-yoruba falls back to `generated-<slug>-<pos>-<counter>` when
 * wiktextract assigned no id to the first sense. That id is a function of
 * PROCESSING ORDER, so it can point at a different etymology after any
 * re-ingest while looking exactly like a real, stable id.
 *
 * It fires 0 times in the current 6272-entry corpus, which is precisely why it
 * must be refused at the write path rather than watched for: nothing in normal
 * operation would ever surface it, so the first time it appeared it would
 * silently produce a citation that drifts. */
export function isCitableEntryId(entryId: string | null | undefined): entryId is string {
  if (!entryId) return false;
  return !entryId.startsWith('generated-');
}

/** What a volunteer is actually being asked about a cited word's spelling.
 *
 * Once a word cites an etymology, this is the whole comparison - our spelling
 * against the one upstream had when a human validated it. No form matching, no
 * tone-tier classification, no candidate list: those exist to GUESS which
 * etymology an uncited word belongs to, and a cited word has nothing to guess.
 *
 * That is what makes the volunteer screen a single question. It also removes a
 * real defect: the old screen offered "keep our spelling (adìyẹ)" and "adopt
 * Kaikki's spelling (adìyẹ)" side by side, because adoptionTarget is populated
 * even when nothing differs - two buttons, identical text, no choice being made.
 *
 * Compared with formsEqual, so a difference of Unicode composition or of case
 * alone is not presented to a volunteer as a spelling disagreement. */
export type PinSpellingComparison = 'matches' | 'differs' | 'not_cited';

export function compareSpellingToPin(displayText: string, pin: UpstreamPin | null | undefined): PinSpellingComparison {
  if (!pin || !pin.canonicalForm) return 'not_cited';
  return formsEqual(displayText, pin.canonicalForm) ? 'matches' : 'differs';
}
