// screens/AxisStatusBadges.tsx
//
// One shared row of per-axis status badges - used on both AllWordsList (browse) and
// AssignmentsList (my assignments), so a curator sees the same status at a glance in either
// place, not a bespoke rendering per screen.
//
// All FOUR axes, and keeping that true is the whole job of this file existing. It has now been
// behind twice: it predated the audio axis, and then the example axis shipped with the field
// already present in its props and simply unread - so a word with no example read as complete on
// every list view while the task queue counted it as outstanding. AxisBanner and WordReview's tab
// bar were right the whole time, which is what made the disagreement hard to notice.
//
// AXIS_ORDER in taskQueue.ts is the list this must match.

import type { AxisDecided } from '../api.js';

export interface AxisStatusBadgesProps {
  axisDecided: AxisDecided;
}

export function AxisStatusBadges({ axisDecided }: AxisStatusBadgesProps) {
  return (
    <>
      <span className={`badge${axisDecided.entry ? ' decided' : ''}`}>
        entry: {axisDecided.entry ? 'decided' : 'not yet decided'}
      </span>{' '}
      <span className={`badge${axisDecided.etymology ? ' decided' : ''}`}>
        etymology: {axisDecided.etymology ? 'decided' : 'not yet decided'}
      </span>{' '}
      <span className={`badge${axisDecided.audio ? ' decided' : ''}`}>
        audio: {axisDecided.audio ? 'recorded' : 'not yet recorded'}
      </span>{' '}
      {/* Per-user like audio, and worded the same way: several different examples are more
          material rather than a conflict, so "given" is about this reader's own contribution. */}
      <span className={`badge${axisDecided.example ? ' decided' : ''}`}>
        example: {axisDecided.example ? 'given' : 'not yet given'}
      </span>
    </>
  );
}
