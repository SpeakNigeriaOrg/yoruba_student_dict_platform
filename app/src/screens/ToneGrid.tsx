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
//
// ---------------------------------------------------------------------------
// The nasal control, and why it belongs on the grid
// ---------------------------------------------------------------------------
// A nasal after a vowel is either a coda nasalising that vowel or a syllable of its own, and
// bare spelling does not always say which. syllabify.ts decides what the letters decide and
// defaults the rest to coda - but tone goes on a syllable's VOWEL when it has one, so the three
// buttons over `lan` write `làn`/`lan`/`lán` and never touch the `n`. There was no sequence of
// taps that reached `aláǹgbá`; the correct answer was unreachable rather than merely non-default.
//
// So the grid is where the control goes: it is already the place a reviewer looks at a word one
// syllable at a time, and freeing a nasal gives that nasal its own tone column, which is the
// whole point of doing it. It appears ONLY on a column where the ambiguity is live - the same
// rule this file already follows for the tone buttons themselves, and the reason it asks
// nasalSplit.ts rather than pattern-matching letters here.

import type { ReactNode } from 'react';
import {
  absorbNasalAt,
  applyTone,
  freeNasalAt,
  toneBearerKind,
  toneOf,
  type Tone,
} from '@yoruba-student-dict-platform/shared';

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
        // Computed rather than predicated: these ARE the new arrays, so the handler has nothing
        // left to decide and cannot render a button that turns out to do nothing.
        const freed = freeNasalAt(syllables, index);
        const absorbed = absorbNasalAt(syllables, index);

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

            {/* At most one of these ever renders, because a syllable cannot both end in an
                absorbed nasal and BE a lone nasal. Both ask nasalSplit.ts, which answers null
                wherever the letters already settle the question - so a rule added there withdraws
                the offer here with no change to this file. */}
            {freed ? (
              <button
                type="button"
                className="btn btn-secondary nasal-split-btn"
                aria-label={`Make the nasal of syllable ${index + 1}${labelSuffix} its own syllable`}
                onClick={() => onChange(freed)}
              >
                split off {lastLetterOf(syllable)}
              </button>
            ) : null}
            {absorbed ? (
              <button
                type="button"
                className="btn btn-secondary nasal-split-btn"
                aria-label={`Join the nasal of syllable ${index + 1}${labelSuffix} to the syllable before it`}
                onClick={() => onChange(absorbed)}
              >
                join to {syllables[index - 1]}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The nasal a "split off" button would free, for its own label - so the button names the letter
 * it is about rather than saying "split" and leaving the reviewer to work out which one. */
function lastLetterOf(syllable: string): string {
  const chars = [...syllable.normalize('NFC')];
  return chars[chars.length - 1] ?? '';
}
