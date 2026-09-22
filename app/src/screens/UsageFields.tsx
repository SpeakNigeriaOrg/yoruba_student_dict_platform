// UsageFields.tsx
//
// The part of speech, usage labels and "survives only inside other words" questions on the entry
// review (0029). Controlled: EntryReview owns the state and turns it into the confirm/set actions
// it submits, the same way it already does for the definition.
//
// Why these three sit together: the case that prompted them is lá "to be big", which had been
// filed as a particle only because there was nowhere to say what is actually true of it - that it
// is a verb, that it is obsolete, and that it survives inside ńlá and Ayélála. Asked separately,
// "particle" keeps looking like the only box that fits.

import {
  USAGE_LABELS,
  acceptsOnlyInDerivedTerms,
  canonicalUsageLabels,
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
  const flag = draft.onlyInDerivedTerms && acceptsOnlyInDerivedTerms(draft.pos || onRecord.pos);
  const flagChanged = flag !== onRecord.onlyInDerivedTerms;
  return {
    ...(posChanged ? { posAction: 'set' as const, pos: draft.pos } : { posAction: 'confirm' as const }),
    ...(labelsChanged ? { usageLabelsAction: 'set' as const, usageLabels: labels } : { usageLabelsAction: 'confirm' as const }),
    ...(flagChanged
      ? { onlyInDerivedTermsAction: 'set' as const, onlyInDerivedTerms: flag }
      : { onlyInDerivedTermsAction: 'confirm' as const }),
  };
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
  const flagApplies = acceptsOnlyInDerivedTerms(draft.pos || null);

  function setPos(pos: string) {
    // Switching to an affix or a character clears the flag rather than hiding a tick nobody can
    // see - the server would drop it anyway (resolveEntryOutcome), and a hidden true is a claim
    // the reviewer can no longer see they are making.
    onChange({ ...draft, pos, onlyInDerivedTerms: acceptsOnlyInDerivedTerms(pos || null) && draft.onlyInDerivedTerms });
  }

  function toggleLabel(value: string, on: boolean) {
    const next = on ? [...draft.usageLabels, value] : draft.usageLabels.filter((l) => l !== value);
    onChange({ ...draft, usageLabels: canonicalUsageLabels(next) });
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

      <fieldset className="usage-fieldset">
        <legend>Usage labels</legend>
        {USAGE_LABELS.map((l) => (
          <label key={l.value} className="field-inline">
            <input
              type="checkbox"
              checked={draft.usageLabels.includes(l.value)}
              onChange={(e) => toggleLabel(l.value, e.target.checked)}
            />
            <span>
              {l.value} <span className="usage-hint">- {l.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="field-note">Leave all unticked for a word in ordinary use today.</p>

      {flagApplies ? (
        <div className="usage-fieldset">
          <label className="field-inline">
            <input
              type="checkbox"
              checked={draft.onlyInDerivedTerms}
              onChange={(e) => onChange({ ...draft, onlyInDerivedTerms: e.target.checked })}
            />
            <span>No longer used as a separate word - survives only inside other words</span>
          </label>
          <p className="field-note">
            For a word (verb, noun, particle...) that no longer appears as a separate word in sentences, only inside
            other words. Not for words that simply cannot stand alone as a whole sentence, such as kò or ń. If it never
            was a word, only something attached to other words, choose Prefix or Suffix instead.
          </p>
          {usage.derivedTerms.length > 0 ? (
            <p className="field-note" aria-label="Derived terms">
              Words in this dictionary built from it: {usage.derivedTerms.map((d) => d.displayText).join(', ')}
            </p>
          ) : draft.onlyInDerivedTerms ? (
            <p className="field-note" aria-label="Derived terms">
              No word in this dictionary lists this one as a part yet, so there is nothing to show as an example.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
