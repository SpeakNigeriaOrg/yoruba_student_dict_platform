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
// Letters are edited per syllable rather than as one whole-word field, because syllable
// boundaries carry meaning a whole-word re-split would silently lose: `gban̄gba` is three
// syllables and `gbangba` is two, and the macron on the nasal is exactly what
// distinguishes them (see shared/src/tone.ts). Editing the syllables directly means a
// boundary can only ever change because someone changed it.
//
// With tone handled by the grid, the only characters the letters boxes need beyond ASCII
// are ẹ ọ ṣ - hence a small palette rather than asking volunteers to install a Yoruba
// keyboard, which a web app cannot do for them anyway.

import { applyTone, lettersOf, toneOf } from '@yoruba-student-dict-platform/shared';
import { EXTRA_LETTERS_LOWER } from './yorubaLetters.js';
import { ToneGrid } from './ToneGrid.js';

export interface ToneEditorProps {
  syllables: string[];
  onChange: (syllables: string[]) => void;
  /** Whether the letters boxes are revealed. Owned by the parent, along with the snapshot
   * Discard restores - the pending decision lives there, not here. */
  editingLetters: boolean;
  onEditLetters: () => void;
  /** Leave the letters editor, keeping what was typed. */
  onKeepLetters: () => void;
  /** Leave the letters editor, throwing away everything changed since it opened. */
  onCancelLetters: () => void;
  /** Whether anything has changed since the letters editor opened, so Discard can say
   * whether there is anything to discard. */
  lettersDirty: boolean;
}

export function ToneEditor({
  syllables,
  onChange,
  editingLetters,
  onEditLetters,
  onKeepLetters,
  onCancelLetters,
  lettersDirty,
}: ToneEditorProps) {
  function setSyllable(index: number, value: string) {
    onChange(syllables.map((s, i) => (i === index ? value : s)));
  }

  /** Appends to a syllable's letters, keeping whatever tone it already has - so tapping ẹ
   * never silently drops the tone the reviewer already chose. */
  function appendLetter(index: number, letter: string) {
    const current = syllables[index];
    const tone = toneOf(current);
    const next = lettersOf(current) + letter;
    setSyllable(index, tone ? applyTone(next, tone) : next);
  }

  return (
    <div aria-label="Tone editor">
      <p className="field-note">
        Each column is one syllable, top to bottom is high / mid / low. The highlighted
        cells are the word's tone as it stands - tap another to change it. Tone is what
        sources most often get wrong, so this is the main thing to check.
      </p>

      <ToneGrid
        syllables={syllables}
        onChange={onChange}
        showAxis={!editingLetters}
        renderPerSyllable={
          editingLetters
            ? (index) => (
                <>
                  <input
                    type="text"
                    className="syllable-letters"
                    aria-label={`Letters of syllable ${index + 1}`}
                    value={lettersOf(syllables[index])}
                    onChange={(e) => {
                      const tone = toneOf(syllables[index]);
                      const next = e.target.value;
                      setSyllable(index, tone ? applyTone(next, tone) : next);
                    }}
                  />
                  <div className="letter-palette" role="group" aria-label={`Extra letters for syllable ${index + 1}`}>
                    {EXTRA_LETTERS_LOWER.map((letter) => (
                      <button
                        key={letter}
                        type="button"
                        className="btn btn-secondary palette-btn"
                        onClick={() => appendLetter(index, letter)}
                      >
                        {letter}
                      </button>
                    ))}
                  </div>
                </>
              )
            : undefined
        }
      />

      <div className="btn-row">
        {editingLetters ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={onKeepLetters}>
              Done with letters
            </button>
            {/* The way out of a half-finished correction. Without it, someone who opened
                the letters editor by mistake, or typed themselves into a mess, had no route
                back to the word as it was - only "Done", which keeps whatever is in the
                boxes. Disabled when nothing has changed, so it also answers "have I
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
          being wrong. The underdots in ẹ ọ ṣ are letters, not tone marks.{' '}
          <strong>Discard changes</strong> puts the word back as it was when you opened this.
        </p>
      ) : null}
    </div>
  );
}
