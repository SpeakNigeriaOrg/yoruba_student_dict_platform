// screens/AxisStatusBadges.tsx
//
// One shared row of per-axis status badges (spelling/definition/
// etymology/audio) - used on both AllWordsList (browse) and
// AssignmentsList (my assignments), so a curator sees the same status
// at a glance in either place, not a bespoke rendering per screen.
// Previously only AllWordsList had this, and it predated the audio axis
// entirely (no badge for it at all).

import type { AxisDecided } from '../api.js';

export interface AxisStatusBadgesProps {
  axisDecided: AxisDecided;
}

export function AxisStatusBadges({ axisDecided }: AxisStatusBadgesProps) {
  return (
    <>
      <span className={`badge${axisDecided.spelling ? ' decided' : ''}`}>
        spelling: {axisDecided.spelling ? 'decided' : 'not yet decided'}
      </span>{' '}
      <span className={`badge${axisDecided.definition ? ' decided' : ''}`}>
        definition: {axisDecided.definition ? 'decided' : 'not yet decided'}
      </span>{' '}
      <span className={`badge${axisDecided.etymology ? ' decided' : ''}`}>
        etymology: {axisDecided.etymology ? 'decided' : 'not yet decided'}
      </span>{' '}
      <span className={`badge${axisDecided.audio ? ' decided' : ''}`}>
        audio: {axisDecided.audio ? 'recorded' : 'not yet recorded'}
      </span>
    </>
  );
}
