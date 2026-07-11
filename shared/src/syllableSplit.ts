// syllableSplit.ts
//
// Port of generate_diagnostics.py's resolve_effective_display_text and
// check_syllable_split - an internal consistency check between vocab.json's
// hand-curated syllable breakdown and syllabify.py's programmatic split,
// independent of Kaikki. Never auto-corrects on its own; a human decides
// via syllableAction: "keep_manual" or "accept_programmatic".

import { syllabifyWord } from './syllabify.js';
import type { DiagnoseEntryResult } from './diagnoseEntry.js';
import type { DiagnoseOverride, VocabEntry } from './types.js';

export interface ResolvedEffectiveDisplayText {
  displayText: string;
  wasSubstituted: boolean;
}

/** A pending adopt_kaikki decision hasn't touched golden_record yet, but
 * checking the syllable split against the OLD displayText while that
 * decision is sitting there drafted is misleading - it can't tell you
 * whether adopting Kaikki's spelling would also resolve the syllable
 * question. So: once adopt_kaikki is decided, check against the spelling
 * it will become, not the spelling on record right now. */
export function resolveEffectiveDisplayText(
  entry: VocabEntry,
  kaikkiResult: DiagnoseEntryResult,
  override?: DiagnoseOverride | null,
): ResolvedEffectiveDisplayText {
  if ((override ?? {}).action === 'adopt_kaikki') {
    const target = kaikkiResult.adoptionTarget;
    if (target && target !== entry.displayText) {
      return { displayText: target, wasSubstituted: true };
    }
  }
  return { displayText: entry.displayText, wasSubstituted: false };
}

export type SyllableSplitStatus =
  | 'skipped_multiword'
  | 'match'
  | 'mismatch'
  | 'resolved_keep_manual'
  | 'resolved_accept_programmatic';

export interface CheckSyllableSplitResult {
  syllableSplitStatus: SyllableSplitStatus;
  syllableSplitManual?: string[];
  syllableSplitProgrammatic?: string[];
  syllableSplitNote?: string;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Compares the hand-curated syllable breakdown against syllabify.ts's
 * programmatic split. Vocab entries whose displayText gets corrected don't
 * get their syllables list auto-updated - it's hand-curated, not derived -
 * so this is the check that would have caught it going stale. */
export function checkSyllableSplit(
  displayText: string,
  syllables: string[],
  override?: DiagnoseOverride | null,
  checkedAgainstPendingAdoption = false,
): CheckSyllableSplitResult {
  const ov = override ?? {};
  const syllableAction = ov.syllableAction;
  const notes: string[] = [];
  if (checkedAgainstPendingAdoption) {
    notes.push(
      'Checked against the pending adopted spelling (not yet written to vocab.json), not the current displayText.',
    );
  }

  if (displayText.includes(' ')) {
    return { syllableSplitStatus: 'skipped_multiword' };
  }

  const expected = syllables.map((s) => s.normalize('NFC').toLowerCase());
  const programmatic = syllabifyWord(displayText);

  if (arraysEqual(programmatic, expected)) {
    const result: CheckSyllableSplitResult = { syllableSplitStatus: 'match' };
    // Either decision, once the splits actually agree, is moot - flag it
    // either way so this doesn't quietly read as "we're deliberately
    // overriding the programmatic split" when there's no real disagreement
    // left.
    if (syllableAction) {
      notes.push(
        `syllableAction override ('${syllableAction}') is now moot - the manual and programmatic splits already agree; safe to remove this entry's syllableAction.`,
      );
    }
    if (notes.length > 0) result.syllableSplitNote = notes.join(' ');
    return result;
  }

  const result: CheckSyllableSplitResult = {
    syllableSplitStatus: 'mismatch',
    syllableSplitManual: syllables,
    syllableSplitProgrammatic: programmatic,
  };
  if (syllableAction === 'keep_manual') {
    result.syllableSplitStatus = 'resolved_keep_manual';
  } else if (syllableAction === 'accept_programmatic') {
    result.syllableSplitStatus = 'resolved_accept_programmatic';
  }
  if (ov.syllableNote) notes.push(ov.syllableNote);
  if (notes.length > 0) result.syllableSplitNote = notes.join(' ');
  return result;
}
