// screens/ToneEditor.tsx
//
// The written-form half of an entry review: the tone grid, plus the letters-correction
// branch that only the entry axis has.
//
// The grid itself lives in ToneGrid.tsx now, shared with the example axis's
// PhraseComposer. What remains here is the part specific to REVIEWING an existing word
// rather than authoring a new phrase.
//
// ---------------------------------------------------------------------------
// Why tone is the question, and why this is an editor rather than a Yes button
// ---------------------------------------------------------------------------
// In this dictionary the base letters of a word are usually right and the tone marks over
// them are usually what a source got wrong. So the review asks about tone directly, on
// every word, rather than asking "is this spelled correctly?" and hiding tone inside the
// answer.
//
// It is also deliberately an EDITOR, not a confirmation. An earlier version showed a
// single "Yes, that's right" button whenever our spelling matched upstream, which did not
// merely irritate reviewers - it corrupted the evidence, because every recorded vote said
// yes when yes was the only thing clickable. Here leaving the grid alone is agreement and
// changing one syllable is disagreement, both in one tap.
//
// ---------------------------------------------------------------------------
// Two dimensions, edited separately
// ---------------------------------------------------------------------------
// Yoruba orthography separates letters (including the underdots of ẹ ọ ṣ, which are
// distinct phonemes) from tone. Changing the letters is a CORRECTION - it asserts the word
// was wrong. Changing the tone is the routine business of this task. So letters sit behind
// an explicit "the letters are wrong", and tone is always live.
//
// ---------------------------------------------------------------------------
// One field for the whole word, not one box per syllable
// ---------------------------------------------------------------------------
// This used to be a fixed-length row of per-syllable boxes, one per entry of the syllable
// array - which meant the array's LENGTH could only ever change through the nasal
// split/absorb buttons below, and never by adding or removing a syllable outright. A
// reviewer who needed to do that had no control for it at all.
//
// So the letters editor is now the same "one text field, syllables re-derived on every
// keystroke" design PhraseComposer already uses for a phrase - a single word is just a
// one-word phrase to it. Typing a letter, deleting one, or retyping the whole thing in a
// different order all fall out of that for free, because nothing here holds a syllable
// COUNT as state; syllabifySpans re-derives it from the text every time.
//
// Only a result that actually syllabifies is propagated to the grid below (via `onChange`
// - see handleLettersChange): most keystrokes land mid-word, and reverting the grid to the
// read-only fallback on every one of them would make it flicker uselessly. The field itself
// still takes every keystroke regardless, exactly as PhraseComposer's does.
//
// A grid interaction - a tone tap, or a nasal split/absorb - always hands back an array
// that is already guaranteed to re-derive from its own text (nasalSplit.ts's `roundTrips`
// check), so that direction just rejoins the array into the field rather than re-parsing it.

import { useEffect, useRef, useState } from 'react';
import { syllabifySpans } from '@yoruba-student-dict-platform/shared';
import { EXTRA_LETTERS_LOWER } from './yorubaLetters.js';
import { ToneGrid } from './ToneGrid.js';

export interface ToneEditorProps {
  syllables: string[];
  onChange: (syllables: string[]) => void;
  /** Whether the letters field is revealed. Owned by the parent, along with the snapshot
   * Discard restores - the pending decision lives there, not here. */
  editingLetters: boolean;
  onEditLetters: () => void;
  /** Leave the letters editor, keeping what was typed. */
  onKeepLetters: () => void;
  /** Leave the letters editor, throwing away everything changed since it opened. */
  onCancelLetters: () => void;
}

export function ToneEditor({
  syllables,
  onChange,
  editingLetters,
  onEditLetters,
  onKeepLetters,
  onCancelLetters,
}: ToneEditorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Where to put the caret after a palette insert. Null when the browser should keep
   * whatever it had - i.e. on ordinary typing. Mirrors PhraseComposer's own field. */
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  /** The free-typed buffer while correcting letters. Deliberately not the syllable array
   * itself: most keystrokes land mid-word, where the text does not yet syllabify, and a
   * buffer that only accepted complete syllables would undo half of what was just typed. */
  const [lettersText, setLettersText] = useState('');
  /** The field's value at the moment the editor opened - null while it is closed. Compared
   * as TEXT rather than via the syllable array for exactly the reason lettersText is a
   * separate buffer at all: typing something that never becomes valid syllables (or
   * un-typing back to nonsense) never reaches `syllables`, and Discard still has to be able
   * to see that something was typed. */
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  const lettersDirty = openedWith !== null && lettersText.normalize('NFC') !== openedWith.normalize('NFC');

  useEffect(() => {
    if (editingLetters) {
      const text = syllables.join('');
      setLettersText(text);
      setOpenedWith(text);
    } else {
      setOpenedWith(null);
    }
    // Keyed on editingLetters alone, deliberately: re-seeding on every `syllables` change
    // would fight the buffer while the reviewer is mid-keystroke (see applyGridChange,
    // which is the one place `syllables` changes without the buffer having caused it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLetters]);

  useEffect(() => {
    if (pendingCaret === null) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(pendingCaret, pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret]);

  /** A tone tap or a nasal split/absorb on the grid below. Rejoins into the buffer rather
   * than re-parsing it, since the array is already known to round-trip. */
  function applyGridChange(next: string[]) {
    setLettersText(next.join(''));
    onChange(next);
  }

  /** Typing in the letters field. Propagated to the grid only when it currently
   * syllabifies; otherwise the grid (and the pending decision it feeds) stays at its last
   * valid split while the field keeps showing exactly what was typed. */
  function handleLettersChange(text: string) {
    setLettersText(text);
    const spans = syllabifySpans(text);
    if (spans) onChange(spans);
  }

  /** Inserts at the caret, not at the end - the same reason PhraseComposer's does: a typo
   * is usually noticed somewhere in the middle, not only at the tail. Replaces the
   * selection if there is one, like a keypress would. */
  function insertLetter(letter: string) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? lettersText.length;
    const end = input?.selectionEnd ?? lettersText.length;
    const next = lettersText.slice(0, start) + letter + lettersText.slice(end);
    handleLettersChange(next);
    setPendingCaret(start + letter.length);
  }

  return (
    <div aria-label="Tone editor">
      <p className="field-note">
        Each column is one syllable, top to bottom is high / mid / low. The highlighted
        cells are the word's tone as it stands - tap another to change it. Tone is what
        sources most often get wrong, so this is the main thing to check.
      </p>

      {editingLetters ? (
        <div className="field">
          <label htmlFor="entry-letters-field">The word, spelled as it is said</label>
          <input
            id="entry-letters-field"
            ref={inputRef}
            type="text"
            value={lettersText}
            onChange={(e) => handleLettersChange(e.target.value)}
          />
          <div className="letter-palette phrase-palette" role="group" aria-label="Extra letters">
            {EXTRA_LETTERS_LOWER.map((letter) => (
              <button
                key={letter}
                type="button"
                className="btn btn-secondary palette-btn"
                onClick={() => insertLetter(letter)}
              >
                {letter}
              </button>
            ))}
          </div>
          {/* syllabifySpans refuses the text mid-edit far more often than it refuses a
              finished word - most partial spellings simply are not complete syllables yet.
              Said plainly rather than left to a silently-stale grid, which read as the
              typing not having registered at all. */}
          {syllabifySpans(lettersText) === null ? (
            <p className="field-note" aria-label="Cannot show a tone grid">
              This can&apos;t be split into syllables yet - the grid below still shows the last
              spelling that could be.
            </p>
          ) : null}
        </div>
      ) : null}

      <ToneGrid syllables={syllables} onChange={editingLetters ? applyGridChange : onChange} />

      <div className="btn-row">
        {editingLetters ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={onKeepLetters}>
              Done with letters
            </button>
            {/* The way out of a half-finished correction. Without it, someone who opened
                the letters editor by mistake, or typed themselves into a mess, had no route
                back to the word as it was - only "Done", which keeps whatever is in the
                field. Disabled when nothing has changed, so it also answers "have I
                actually altered anything?". */}
            <button type="button" className="btn btn-danger" onClick={onCancelLetters} disabled={!lettersDirty}>
              Discard changes
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={onEditLetters}>
            The letters are wrong
          </button>
        )}
      </div>
      {editingLetters ? (
        <p className="field-note">
          Changing the letters says the word itself was wrong, which is rarer than a tone
          being wrong. The underdots in ẹ ọ ṣ are letters, not tone marks. Typed letters carry
          no tone of their own - set it on the grid above once the spelling is right.{' '}
          <strong>Discard changes</strong> puts the word back as it was when you opened this.
        </p>
      ) : null}
    </div>
  );
}
