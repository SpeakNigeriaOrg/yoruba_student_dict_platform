// screens/AxisBanner.tsx
//
// Shared header for all three review screens: the word's read-only
// spelling/definition context, plus an explicit banner naming all three
// review axes and which one this screen covers. Extracted after a
// confusing first pass (only Etymology existed, with no indication a
// curator was even looking at just one of three separate axes) - every
// axis screen needs the same orientation, not just Etymology's.

import type { AxisDecided } from '../api.js';

export interface AxisBannerProps {
  displayText: string;
  syllables: string[];
  definition: string | null;
  axisDecided: AxisDecided;
  currentAxis: 'Spelling' | 'Definition' | 'Etymology';
}

function AxisStatusBadge({ done, doneLabel = 'decided', pendingLabel = 'not yet decided' }: { done: boolean; doneLabel?: string; pendingLabel?: string }) {
  return <span className={`badge${done ? ' decided' : ''}`}>{done ? doneLabel : pendingLabel}</span>;
}

export function AxisBanner({ displayText, syllables, definition, axisDecided, currentAxis }: AxisBannerProps) {
  return (
    <>
      <h2>{displayText}</h2>
      <p>
        <strong>Syllables:</strong> {syllables.join(' · ')}
        <br />
        <strong>Definition:</strong> {definition ?? '(not yet decided)'}
      </p>

      <p aria-label="Review axis status">
        This platform splits word review into four separate axes, tracked independently:{' '}
        <strong>Spelling</strong> (<AxisStatusBadge done={axisDecided.spelling} />),{' '}
        <strong>Definition</strong> (<AxisStatusBadge done={axisDecided.definition} />),{' '}
        <strong>Etymology</strong> (<AxisStatusBadge done={axisDecided.etymology} />), and{' '}
        <strong>Audio</strong> (<AxisStatusBadge done={axisDecided.audio} doneLabel="recorded" pendingLabel="not yet recorded" />).
        <br />
        You are viewing <strong>{currentAxis}</strong>.
      </p>
    </>
  );
}
