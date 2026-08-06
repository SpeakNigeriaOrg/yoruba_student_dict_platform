// screens/ToneEditor.tsx
//
// The written-form half of an entry review, as one control per syllable.
//
// ---------------------------------------------------------------------------
// Why tone is the question, and why this is an editor rather than a Yes button
// ---------------------------------------------------------------------------
// In this dictionary the base letters of a word are usually right and the tone
// marks over them are usually what a source got wrong. So the review asks about
// tone directly, on every word, rather than asking "is this spelled correctly?" and
// hiding tone inside the answer.
//
// It is also deliberately an EDITOR, not a confirmation. An earlier version of this
// screen showed a single "Yes, that's right" button whenever our spelling matched
// upstream, which did not merely irritate reviewers - it corrupted the evidence,
// because every recorded vote said yes when yes was the only thing clickable. Here
// leaving the row alone is agreement and changing one syllable is disagreement, both
// in one tap, so the consensus tally means something.
//
// ---------------------------------------------------------------------------
// Two dimensions, edited separately
// ---------------------------------------------------------------------------
// Yoruba orthography separates letters (including the underdots of ẹ ọ ṣ, which are
// distinct phonemes) from tone. Changing the letters is a CORRECTION - it asserts the
// word was wrong. Changing the tone is the routine business of this task. So letters
// sit behind an explicit "the letters are wrong", and tone is always live.
//
// Letters are edited per syllable rather than as one whole-word field, because
// syllable boundaries carry meaning that a whole-word re-split would silently lose:
// `gban̄gba` is three syllables and `gbangba` is two, and the macron on the nasal is
// exactly what distinguishes them (see shared/src/tone.ts). Editing the syllables
// directly means a boundary can only ever change because someone changed it.
//
// With tone handled here, the only characters the letters boxes need beyond ASCII are
// ẹ ọ ṣ - hence the three-button palette rather than asking volunteers to install a
// Yoruba keyboard, which a web app cannot do for them anyway.

import { applyTone, lettersOf, toneBearerKind, toneOf, type Tone } from '@yoruba-student-dict-platform/shared';

const TONE_CHOICES: Array<{ tone: Tone; label: string; hint: string }> = [
  { tone: 'low', label: 'à', hint: 'low' },
  { tone: 'mid', label: 'a', hint: 'mid' },
  { tone: 'high', label: 'á', hint: 'high' },
];

/** The three characters a Yoruba keyboard would be needed for. Tone is handled by
 * the buttons, so this is genuinely the whole gap. */
const EXTRA_LETTERS = ['ẹ', 'ọ', 'ṣ'];

export interface ToneEditorProps {
  /** Syllables of the word as it currently stands, capitalization preserved. */
  syllables: string[];
  onChange: (syllables: string[]) => void;
  /** Whether the letters boxes are revealed. Owned by the parent so the reset is
   * visible next to the rest of the pending decision. */
  editingLetters: boolean;
  onEditLetters: () => void;
  onStopEditingLetters: () => void;
}

export function ToneEditor({
  syllables,
  onChange,
  editingLetters,
  onEditLetters,
  onStopEditingLetters,
}: ToneEditorProps) {
  function setSyllable(index: number, value: string) {
    onChange(syllables.map((s, i) => (i === index ? value : s)));
  }

  function setTone(index: number, tone: Tone) {
    setSyllable(index, applyTone(syllables[index], tone));
  }

  /** Appends to a syllable's letters, keeping whatever tone it already has - so
   * tapping ẹ never silently drops the tone the reviewer already chose. */
  function appendLetter(index: number, letter: string) {
    const current = syllables[index];
    const tone = toneOf(current);
    const next = lettersOf(current) + letter;
    setSyllable(index, tone ? applyTone(next, tone) : next);
  }

  return (
    <div aria-label="Tone editor">
      <p className="field-note">
        Tap a syllable's tone to change it. Tone is what sources most often get wrong, so this is the main thing to
        check.
      </p>

      <div className="syllable-row">
        {syllables.map((syllable, index) => {
          const bearerTone = toneOf(syllable);
          // No vowel and no syllabic nasal: nothing can carry tone. Wiktionary has
          // bare letter-name entries like `gb` that syllabify this way.
          const toneable = toneBearerKind(syllable) !== null;

          return (
            <div key={index} className="syllable-cell">
              <div className="syllable-face" aria-label={`Syllable ${index + 1}`}>
                {syllable}
              </div>

              {editingLetters ? (
                <>
                  <input
                    type="text"
                    className="syllable-letters"
                    aria-label={`Letters of syllable ${index + 1}`}
                    value={lettersOf(syllable)}
                    onChange={(e) => {
                      const tone = toneOf(syllable);
                      const next = e.target.value;
                      setSyllable(index, tone ? applyTone(next, tone) : next);
                    }}
                  />
                  <div className="letter-palette" role="group" aria-label={`Extra letters for syllable ${index + 1}`}>
                    {EXTRA_LETTERS.map((letter) => (
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
              ) : null}

              {toneable ? (
                <div className="tone-choices" role="group" aria-label={`Tone of syllable ${index + 1}`}>
                  {TONE_CHOICES.map((choice) => (
                    <button
                      key={choice.tone}
                      type="button"
                      className={`btn tone-btn ${bearerTone === choice.tone ? 'btn-primary' : 'btn-secondary'}`}
                      aria-pressed={bearerTone === choice.tone}
                      aria-label={`Syllable ${index + 1} ${choice.hint} tone`}
                      onClick={() => setTone(index, choice.tone)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="field-note">no tone</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="btn-row">
        {editingLetters ? (
          <button type="button" className="btn btn-secondary" onClick={onStopEditingLetters}>
            Done with letters
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={onEditLetters}>
            The letters are wrong
          </button>
        )}
      </div>
      {editingLetters ? (
        <p className="field-note">
          Changing the letters says the word itself was wrong, which is rarer than a tone being wrong. The underdots in
          ẹ ọ ṣ are letters, not tone marks.
        </p>
      ) : null}
    </div>
  );
}
