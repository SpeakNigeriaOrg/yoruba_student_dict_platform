// screens/ToneGrid.tsx
//
// The tone control: one COLUMN per syllable, one ROW per tone, high at the top.
//
// Extracted from ToneEditor once a second caller appeared (PhraseComposer, which renders
// one grid per word of an example phrase). One definition of the grid, two users.
//
// ---------------------------------------------------------------------------
// Why the arrangement is the feature
// ---------------------------------------------------------------------------
// Vertical position means pitch, so the highlighted cells trace the word's tone contour
// left to right - `èékánná` reads as a shape (low, then three highs) rather than as four
// separate answers to hold in your head, and an implausible contour is visible instead of
// deduced. Ordering it low-first would make position actively misleading.
//
// Each button renders THIS syllable carrying that tone, not a generic `à a á`: the result
// is visible before it is chosen, and the mid-tone rule shows itself rather than needing
// to be known (`du` on a vowel, `n̄` on a syllabic nasal).

import type { ReactNode } from 'react';
import { applyTone, toneBearerKind, toneOf, type Tone } from '@yoruba-student-dict-platform/shared';

/** Top to bottom: HIGH first, so vertical position matches pitch. */
const TONES: Array<{ tone: Tone; hint: string }> = [
  { tone: 'high', hint: 'high' },
  { tone: 'mid', hint: 'mid' },
  { tone: 'low', hint: 'low' },
];

export interface ToneGridProps {
  syllables: string[];
  onChange: (syllables: string[]) => void;
  /** The pitch-axis labels down the left. Off when a caller stacks something above the
   * tone buttons (the letters boxes), because those make each column taller than a bare
   * label column and a misaligned axis is worse than none. */
  showAxis?: boolean;
  /** Disambiguates aria-labels when a screen shows more than one grid.
   *
   * PhraseComposer renders a grid per word, so without this every word would announce
   * "syllable 1" and neither a screen reader user nor a test could tell which word a
   * control belonged to.
   *
   * A SUFFIX rather than a prefix, deliberately: ' of word 2' gives "Syllable 1 of word 2
   * mid tone", and an empty value leaves the entry axis's labels byte-identical to what
   * they were before this extraction - so its tests keep testing the same thing. */
  labelSuffix?: string;
  /** Injected above the tone buttons of each syllable - the entry axis puts its letters
   * box and palette here. Kept as a render prop so ToneGrid knows nothing about letters
   * editing, which is the one thing that differs between its two callers. */
  renderPerSyllable?: (index: number) => ReactNode;
}

export function ToneGrid({ syllables, onChange, showAxis = true, labelSuffix = '', renderPerSyllable }: ToneGridProps) {
  function setTone(index: number, tone: Tone) {
    onChange(syllables.map((s, i) => (i === index ? applyTone(s, tone) : s)));
  }

  return (
    <div className={`tone-grid${showAxis ? '' : ' editing-letters'}`}>
      {showAxis ? (
        <div className="tone-axis" aria-hidden="true">
          {TONES.map(({ tone, hint }) => (
            <div key={tone} className="tone-axis-label">
              {hint}
            </div>
          ))}
        </div>
      ) : null}

      {syllables.map((syllable, index) => {
        const bearerTone = toneOf(syllable);
        const toneable = toneBearerKind(syllable) !== null;

        return (
          <div key={index} className="syllable-col">
            {/* Shown only when no button is highlighted, which is the one case where the
                column would otherwise have nothing identifying it: a syllable with
                nothing that can carry tone at all - Wiktionary's bare letter entries like
                `gb`, or a half-typed syllable mid-edit. An unmarked syllabic nasal is NOT
                one of these; it reads as mid (the macron convention is not universal), so
                its column is highlighted like any other. */}
            {bearerTone === null ? (
              <div className="syllable-face" aria-label={`Syllable ${index + 1}${labelSuffix}`}>
                {syllable}
              </div>
            ) : null}

            {renderPerSyllable?.(index)}

            {toneable ? (
              <div className="tone-choices" role="group" aria-label={`Tone of syllable ${index + 1}${labelSuffix}`}>
                {TONES.map(({ tone, hint }) => (
                  <button
                    key={tone}
                    type="button"
                    className={`btn tone-btn ${bearerTone === tone ? 'btn-primary' : 'btn-secondary'}`}
                    aria-pressed={bearerTone === tone}
                    // The visible text is the syllable itself, so the label carries the
                    // tone NAME - three near-identical Yoruba syllables would otherwise be
                    // indistinguishable to a screen reader.
                    aria-label={`Syllable ${index + 1}${labelSuffix} ${hint} tone`}
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
  );
}
