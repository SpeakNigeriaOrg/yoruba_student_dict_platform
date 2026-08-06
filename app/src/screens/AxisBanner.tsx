// screens/AxisBanner.tsx
//
// Shared header for the review screens: the word's read-only context, plus a
// compact chip row showing which axes are done. Used by EntryReview and
// EtymologyReview, so every axis screen gives the same orientation.
//
// The chips replaced a full explanatory paragraph ("This platform splits
// word review into four separate axes, tracked independently: ...") plus a
// "You are viewing X" line. On a phone that prose consumed most of the
// viewport before the actual task, and the axis tab bar already says which
// axis is open. The aria-label is unchanged so it stays queryable.

import type { AxisDecided } from '../api.js';

export interface AxisBannerProps {
  displayText: string;
  syllables: string[];
  definition: string | null;
  axisDecided: AxisDecided;
  currentAxis: 'Entry' | 'Etymology';
  /** Off in the task queue.
   *
   * The chips name the same three axes as the tab bar, so wherever the tabs are
   * shown they are a second copy of the same information - and in the queue,
   * where the tabs are gone, they are worse than redundant: they advertise two
   * other axes to someone who was handed one specific task, and the progress line
   * above already says where they are. */
  showAxisChips?: boolean;
}

export function AxisBanner({
  displayText,
  syllables,
  definition,
  axisDecided,
  currentAxis,
  showAxisChips = true,
}: AxisBannerProps) {
  const chips: Array<{ label: string; done: boolean }> = [
    { label: 'entry', done: axisDecided.entry },
    { label: 'etymology', done: axisDecided.etymology },
    { label: 'audio', done: axisDecided.audio },
  ];

  return (
    <>
      <h2>{displayText}</h2>
      <p>
        <strong>Syllables:</strong> {syllables.join(' · ')}
        <br />
        <strong>Definition:</strong> {definition ?? '(not yet decided)'}
      </p>

      {showAxisChips ? (
        <>
          <p aria-label="Review axis status" className="badge-row">
            {chips.map((chip) => (
              <span key={chip.label} className={`badge${chip.done ? ' decided' : ''}`}>
                {chip.done ? `${chip.label} ✓` : chip.label}
              </span>
            ))}
          </p>
          {/* The tab bar shows this visually; kept for screen readers, which
              don't get the tab bar's aria-current as page context here. */}
          <span className="visually-hidden">You are viewing {currentAxis}.</span>
        </>
      ) : null}
    </>
  );
}
