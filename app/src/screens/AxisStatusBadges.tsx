// screens/AxisStatusBadges.tsx
//
// One shared row of per-axis status badges - used by AssignmentsList (my assignments) and
// AdminUserDetail (one person's assignments), so the same status looks the same in both.
//
// These flags are PER-USER by construction (api/src/reviewShared.ts's AxisDecided), which
// is right for both callers: they are answering "what does this person still owe?". They
// are wrong for a corpus-wide view, and used to back the browse screen anyway - which is
// why the curator survey (DictionarySurvey.tsx) uses StateMarks and the global status
// instead. Do not reach for this component on a curator surface.
//
// All FOUR axes, and keeping that true is the whole job of this file existing. It has now been
// behind twice: it predated the audio axis, and then the example axis shipped with the field
// already present in its props and simply unread - so a word with no example read as complete on
// every list view while the task queue counted it as outstanding. AxisBanner and WordReview's tab
// bar were right the whole time, which is what made the disagreement hard to notice.
//
// AXIS_ORDER in taskQueue.ts is the list this must match.
//
// Audio has THREE states, unlike the others - see the note on its badge below.

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
      {/* Three states, not two: a recording can exist and still be excluded from publish because
          the word has been respelled under it. That used to read as "not yet recorded", which was
          both wrong and unactionable - the recording is there, it is the spelling that moved. */}
      <span
        className={`badge${axisDecided.audio ? (axisDecided.audioDiverges ? ' diverged' : ' decided') : ''}`}
      >
        audio:{' '}
        {!axisDecided.audio ? 'not yet recorded' : axisDecided.audioDiverges ? "recorded - won't publish" : 'recorded'}
      </span>{' '}
      {/* Per-user like audio, and worded the same way: several different examples are more
          material rather than a conflict, so "given" is about this reader's own contribution. */}
      <span className={`badge${axisDecided.example ? ' decided' : ''}`}>
        example: {axisDecided.example ? 'given' : 'not yet given'}
      </span>
    </>
  );
}
