// screens/WordReview.tsx
//
// The axis tab bar plus whichever axis screen is open. Extracted from
// App.tsx so the two ways into a word - the task queue, and direct
// navigation from Browse/Users - render the identical thing rather than
// keeping two copies of the tab bar in sync.

import { useEffect, useState } from 'react';
import { AudioRecording } from './AudioRecording.js';
import { ExampleContribution } from './ExampleContribution.js';
import { EntryReview } from './EntryReview.js';
import { EtymologyReview } from './EtymologyReview.js';
import { getAxisStatus, type AxisDecided } from '../api.js';
import { nextAxisForWord } from '../taskQueue.js';
import { AXES, type Axis } from '../route.js';

const AXIS_LABELS: Record<Axis, string> = {
  entry: 'Entry',
  etymology: 'Etymology',
  audio: 'Audio',
  example: 'Example',
};

export interface WordReviewProps {
  wordId: string;
  axis: Axis;
  isCurator: boolean;
  onAxisChange: (axis: Axis) => void;
  /** Forwarded to the axis screens so a queue can advance on submit. */
  onDecided?: () => void;
  /** Off in the task queue, on when browsing a word directly.
   *
   * The queue's whole premise is that it chooses the next task, and tabs invite
   * exactly the navigation that defeats it - a volunteer handed one question
   * should not first have to notice they are on the right one of three. Browsing
   * a word is the opposite case: you arrived at a word, not a task, and moving
   * between its axes is the point.
   *
   * The tabs also duplicated AxisBanner's chips, so the same three words appeared
   * twice on one phone screen. */
  showAxisTabs?: boolean;
  /** Move to this word's next unfinished axis after a decision.
   *
   * On for the word route, off in the task queue - not because the queue does not
   * advance, but because it advances itself: its onDecided re-reads the assignments and
   * picks the next task, which may be another axis of this word OR the next word
   * entirely. Two mechanisms racing on the same submit would fight. */
  advanceAfterDecision?: boolean;
}

export function WordReview({
  wordId,
  axis,
  isCurator,
  onAxisChange,
  onDecided,
  showAxisTabs = true,
  advanceAfterDecision = false,
}: WordReviewProps) {
  const [axisStatus, setAxisStatus] = useState<AxisDecided | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // Re-fetched on every axis switch (not just word selection) so the tab
  // colors pick up a decision just made on another axis as soon as the
  // curator switches away from it - cheap, and avoids threading a
  // "decision changed" callback through every review screen. refreshToken
  // additionally re-runs it after a submit, so the tab the user just
  // finished turns green without a navigation.
  useEffect(() => {
    let cancelled = false;
    getAxisStatus(wordId)
      .then((result) => {
        if (!cancelled) setAxisStatus(result);
      })
      .catch(() => {
        if (!cancelled) setAxisStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wordId, axis, refreshToken]);

  async function handleDecided() {
    setRefreshToken((n) => n + 1);
    onDecided?.();
    if (!advanceAfterDecision) return;

    // Re-read rather than assuming this axis is now done: a volunteer's submission is a
    // contribution, not a decision, and axisDecided counts a contribution only when it
    // is the caller's own and still active (api/src/reviewShared.ts). Asking the server
    // is the only way to know what is actually left.
    try {
      const status = await getAxisStatus(wordId);
      setAxisStatus(status);
      const next = nextAxisForWord(status, axis);
      if (next) onAxisChange(next);
    } catch {
      // Staying put is a safe failure: the tab bar is still there, and the decision
      // itself already succeeded.
    }
  }

  return (
    <>
      {showAxisTabs ? (
        <nav aria-label="Review axis tabs" className="axis-tabs">
          {AXES.map((key) => (
            <button
              key={key}
              type="button"
              aria-current={axis === key ? 'page' : undefined}
              className={axisStatus ? (axisStatus[key] ? 'axis-complete' : 'axis-pending') : undefined}
              onClick={() => onAxisChange(key)}
            >
              {AXIS_LABELS[key]}
            </button>
          ))}
        </nav>
      ) : null}
      {axis === 'entry' ? (
        <EntryReview wordId={wordId} isCurator={isCurator} onDecided={handleDecided} showAxisChips={showAxisTabs} />
      ) : null}
      {axis === 'etymology' ? (
        <EtymologyReview wordId={wordId} isCurator={isCurator} onDecided={handleDecided} showAxisChips={showAxisTabs} />
      ) : null}
      {axis === 'audio' ? <AudioRecording wordId={wordId} isCurator={isCurator} onDecided={handleDecided} /> : null}
      {axis === 'example' ? <ExampleContribution wordId={wordId} onDecided={handleDecided} /> : null}
    </>
  );
}
