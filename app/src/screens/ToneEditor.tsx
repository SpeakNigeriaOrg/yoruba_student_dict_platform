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

/** Top to bottom: HIGH first, so vertical position means pitch.
 *
 * That ordering is the whole point of the grid. One column per syllable and one row per
 * tone means the selected cells trace the word's tone contour left to right - `èékánná`
 * reads as a shape (low, then three highs) rather than as four separate answers a
 * reviewer has to hold in their head. An implausible contour becomes visible instead of
 * needing to be reasoned about.
 *
 * No fixed labels on the cells: each is rendered as THIS syllable carrying that tone.
 * The first version used static `à a á` on every button of every syllable, so the
 * choices under `dì` read "à a á" - three letters not in the syllable being edited. */
const TONES: Array<{ tone: Tone; hint: string }> = [
  { tone: 'high', hint: 'high' },
  { tone: 'mid', hint: 'mid' },
  { tone: 'low', hint: 'low' },
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
        Each column is one syllable, top to bottom is high / mid / low. The highlighted
        cells are the word's tone as it stands - tap another to change it. Tone is what
        sources most often get wrong, so this is the main thing to check.
      </p>

      <div className={`tone-grid${editingLetters ? ' editing-letters' : ''}`}>
        {/* The pitch axis. Hidden while the letters boxes are open: those make each
            column taller by a different amount than a bare label column, and a
            misaligned axis is worse than none. The diacritics still carry it - every
            cell in the top row has an acute, every cell in the bottom row a grave. */}
        {editingLetters ? null : (
          <div className="tone-axis" aria-hidden="true">
            {TONES.map(({ tone, hint }) => (
              <div key={tone} className="tone-axis-label">
                {hint}
              </div>
            ))}
          </div>
        )}

        {syllables.map((syllable, index) => {
          const bearerTone = toneOf(syllable);
          // No vowel and no syllabic nasal: nothing can carry tone. Wiktionary has
          // bare letter-name entries like `gb` that syllabify this way.
          const toneable = toneBearerKind(syllable) !== null;

          return (
            <div key={index} className="syllable-col">
              {/* Shown only when no button is highlighted, which is when the row would
                  otherwise have nothing identifying it. Two cases: a syllable that
                  cannot carry tone at all (Wiktionary's bare letter entries), and an
                  under-marked syllabic nasal, where the source never said which tone it
                  is and toneOf refuses to guess. When a tone IS selected the highlighted
                  button already shows the syllable, so a face would just repeat it. */}
              {bearerTone === null ? (
                <div className="syllable-face" aria-label={`Syllable ${index + 1}`}>
                  {syllable}
                </div>
              ) : null}

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
                  {TONES.map(({ tone, hint }) => (
                    <button
                      key={tone}
                      type="button"
                      className={`btn tone-btn ${bearerTone === tone ? 'btn-primary' : 'btn-secondary'}`}
                      aria-pressed={bearerTone === tone}
                      // The visible text is the syllable itself, so the aria-label
                      // carries the tone NAME - otherwise a screen reader would
                      // announce three near-identical Yoruba syllables with no way to
                      // tell which button is which.
                      aria-label={`Syllable ${index + 1} ${hint} tone`}
                      onClick={() => setTone(index, tone)}
                    >
                      {applyTone(syllable, tone)}
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
