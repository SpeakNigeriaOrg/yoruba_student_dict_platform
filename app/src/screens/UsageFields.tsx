// UsageFields.tsx
//
// The part of speech, usage labels and "survives only inside other words" questions on the entry
// review (0029). Controlled: EntryReview owns the state and turns it into the confirm/set actions
// it submits, the same way it already does for the definition.
//
// UsageCheckboxes (the labels and the flag, without the part of speech) is also rendered by
// AddWord, so a word can be created already saying it is obsolete and survives only inside other
// words - rather than created bare and corrected by a second vote straight afterwards.
//
// Why these three sit together: the case that prompted them is lá "to be big", which had been
// filed as a particle only because there was nowhere to say what is actually true of it - that it
// is a verb, that it is obsolete, and that it survives inside ńlá and Ayélála. Asked separately,
// "particle" keeps looking like the only box that fits.

import {
  USAGE_LABELS,
  canonicalUsageLabels,
  fixedOnlyInDerivedTerms,
  resolveOnlyInDerivedTerms,
} from '@yoruba-student-dict-platform/shared';
import type { ApplyEntryDecisionInput, EntryReviewResult } from '../api.js';
import { PartOfSpeechField } from './PartOfSpeechField.js';

export interface UsageDraft {
  pos: string;
  usageLabels: string[];
  onlyInDerivedTerms: boolean;
}

export function usageDraftFrom(usage: EntryReviewResult['usage']): UsageDraft {
  return { pos: usage.pos ?? '', usageLabels: usage.usageLabels, onlyInDerivedTerms: usage.onlyInDerivedTerms };
}

/** The actions to submit: 'set' for what the reviewer changed, 'confirm' for what they left.
 *
 * Choosing the "(choose one)" placeholder is not a claim that the word has no part of speech -
 * nothing can clear one, by design (see writeEntryUsageInTransaction) - so it confirms. */
export function usageActions(
  draft: UsageDraft,
  onRecord: EntryReviewResult['usage'],
): Pick<
  ApplyEntryDecisionInput,
  'posAction' | 'pos' | 'usageLabelsAction' | 'usageLabels' | 'onlyInDerivedTermsAction' | 'onlyInDerivedTerms'
> {
  const posChanged = draft.pos !== '' && draft.pos !== (onRecord.pos ?? '');
  const labels = canonicalUsageLabels(draft.usageLabels);
  const labelsChanged = labels.join('|') !== canonicalUsageLabels(onRecord.usageLabels).join('|');
  const flag = resolveOnlyInDerivedTerms(draft.pos || onRecord.pos, draft.onlyInDerivedTerms);
  const flagChanged = flag !== onRecord.onlyInDerivedTerms;
  return {
    ...(posChanged ? { posAction: 'set' as const, pos: draft.pos } : { posAction: 'confirm' as const }),
    ...(labelsChanged ? { usageLabelsAction: 'set' as const, usageLabels: labels } : { usageLabelsAction: 'confirm' as const }),
    ...(flagChanged
      ? { onlyInDerivedTermsAction: 'set' as const, onlyInDerivedTerms: flag }
      : { onlyInDerivedTermsAction: 'confirm' as const }),
  };
}

/** The usage-label checkboxes and the "survives only inside other words" box, for whatever part of
 * speech the caller has. The flag box is hidden when that pos rules it out; callers must also drop
 * a tick made before the pos changed (usageActions does, and AddWord does at submit). */
export function UsageCheckboxes({
  usageLabels,
  onlyInDerivedTerms,
  pos,
  onChange,
  derivedTerms,
}: {
  usageLabels: string[];
  onlyInDerivedTerms: boolean;
  pos: string | null;
  onChange: (next: { usageLabels: string[]; onlyInDerivedTerms: boolean }) => void;
  /** Words this one is a part of, when known. Omitted on Add Word, where the word is new and
   * nothing can list it as a component yet. */
  derivedTerms?: { displayText: string }[];
}) {
  function toggleLabel(value: string, on: boolean) {
    const next = on ? [...usageLabels, value] : usageLabels.filter((l) => l !== value);
    onChange({ usageLabels: canonicalUsageLabels(next), onlyInDerivedTerms });
  }

  return (
    <>
      <fieldset className="usage-fieldset">
        <legend>Usage labels</legend>
        {USAGE_LABELS.map((l) => (
          <label key={l.value} className="field-inline">
            <input
              type="checkbox"
              checked={usageLabels.includes(l.value)}
              onChange={(e) => toggleLabel(l.value, e.target.checked)}
            />
            <span>
              {l.value} <span className="usage-hint">- {l.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="field-note">Leave all unticked for a word in ordinary use today.</p>

      {/* One field for every entry that is not a standalone word (partsOfSpeech.ts). An affix always
          is one, so the box shows ticked and locked rather than disappearing - the answer is still
          visible, it just is not the reviewer's to give. A letter is neither, so it is not shown. */}
      {fixedOnlyInDerivedTerms(pos) === false ? null : fixedOnlyInDerivedTerms(pos) === true ? (
        <div className="usage-fieldset">
          <label className="field-inline">
            <input type="checkbox" checked disabled readOnly />
            <span>Not a standalone word</span>
          </label>
          <p className="field-note">An affix is never a standalone word, so this is always ticked for one.</p>
        </div>
      ) : (
        <div className="usage-fieldset">
          <label className="field-inline">
            <input
              type="checkbox"
              checked={onlyInDerivedTerms}
              onChange={(e) => onChange({ usageLabels, onlyInDerivedTerms: e.target.checked })}
            />
            <span>Not a standalone word - survives only inside other words</span>
          </label>
          <p className="field-note">
            For a word (verb, noun, particle...) that no longer appears as a separate word in sentences, only inside
            other words. Not for words that simply cannot stand alone as a whole sentence, such as kò or ń. If it never
            was a word, only something attached to other words, choose Prefix or Suffix instead.
          </p>
          {derivedTerms === undefined ? null : derivedTerms.length > 0 ? (
            <p className="field-note" aria-label="Derived terms">
              Words in this dictionary built from it: {derivedTerms.map((d) => d.displayText).join(', ')}
            </p>
          ) : onlyInDerivedTerms ? (
            <p className="field-note" aria-label="Derived terms">
              No word in this dictionary lists this one as a part yet, so there is nothing to show as an example.
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

export function UsageFields({
  draft,
  onChange,
  usage,
}: {
  draft: UsageDraft;
  onChange: (next: UsageDraft) => void;
  usage: EntryReviewResult['usage'];
}) {
  function setPos(pos: string) {
    // A part of speech that decides the flag sets it (an affix: on; a letter: off). Leaving one of
    // those for an ordinary word clears it, rather than carrying over a tick the reviewer never
    // made - the lock set it, not them.
    const fixed = fixedOnlyInDerivedTerms(pos || null);
    const wasFixed = fixedOnlyInDerivedTerms(draft.pos || null) !== null;
    onChange({ ...draft, pos, onlyInDerivedTerms: fixed ?? (wasFixed ? false : draft.onlyInDerivedTerms) });
  }

  return (
    <>
      <h3>Part of speech and usage</h3>
      {usage.pinPos ? (
        <p className="field-note" aria-label="Wiktionary part of speech">
          Wiktionary files this under: {usage.pinPos}
          {draft.pos && draft.pos !== usage.pinPos ? ' - different from ours, which is worth a second look either way.' : ''}
        </p>
      ) : null}
      <PartOfSpeechField id="entry-pos-field" value={draft.pos} onChange={setPos} />
      <UsageCheckboxes
        usageLabels={draft.usageLabels}
        onlyInDerivedTerms={draft.onlyInDerivedTerms}
        pos={draft.pos || null}
        onChange={(next) => onChange({ ...draft, ...next })}
        derivedTerms={usage.derivedTerms}
      />
    </>
  );
}
