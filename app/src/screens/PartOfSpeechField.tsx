// PartOfSpeechField.tsx
//
// Shared by AddWord (both tabs) and EntryReview, which asks a reviewer to confirm or correct the
// part of speech of a word that already exists.

import { PARTS_OF_SPEECH, isKnownPartOfSpeech } from '@yoruba-student-dict-platform/shared';

/** The part of speech, as a choice from upstream's own tags rather than as free text.
 *
 * Both AddWord tabs render this - the Word tab's off-path branch and the Phrase tab - and both used to
 * render their own text input with an `e.g. noun, verb, intj` placeholder. See
 * shared/src/partsOfSpeech.ts for why the vocabulary is closed: the field is collected so the
 * entry can be sent upstream one day, and `interjection` is not a value upstream takes.
 *
 * A value already stored that is NOT in the list keeps its own option rather than being dropped.
 * Rows predate this control, and silently re-selecting the placeholder for one would turn "we
 * recorded something odd" into "we recorded nothing" the next time anybody opened the form. */
export function PartOfSpeechField({
  id,
  value,
  onChange,
  note,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** An extra sentence for the tab that needs one. See the Phrase tab's, which says what its
   * default is and when to move off it. */
  note?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Part of speech</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(choose one)</option>
        {value && !isKnownPartOfSpeech(value) ? <option value={value}>{value} (already recorded)</option> : null}
        {PARTS_OF_SPEECH.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="field-note">
        Wiktionary&apos;s own categories, because this is the entry we would send there - so it has to be one of
        theirs, not the word an English grammar lesson would use.
        {note ? ` ${note}` : ''}
      </p>
    </div>
  );
}

