// screens/AxisReviewBadges.tsx
//
// Per-axis reviewStatus (not_started/in_review/passed) badges for the
// admin assignment detail view - kept separate from AxisStatusBadges
// (which is boolean-only: decided or not) since the value domain here is
// a 3-state string, not a boolean; shown alongside AxisStatusBadges
// rather than replacing it, since AxisDecided.audio has no review-status
// analogue (there's no "review" step for a recording, see reviewShared.ts).

import type { ReviewStatus } from '../api.js';

export interface AxisReviewBadgesProps {
  reviewStatus: ReviewStatus;
}

const LABELS: Record<ReviewStatus['spelling'], string> = {
  not_started: 'not started',
  in_review: 'in review',
  passed: 'passed',
};

function badgeClass(status: ReviewStatus['spelling']): string {
  if (status === 'passed') return 'badge decided';
  if (status === 'in_review') return 'badge';
  return 'badge not-started';
}

export function AxisReviewBadges({ reviewStatus }: AxisReviewBadgesProps) {
  return (
    <>
      <span className={badgeClass(reviewStatus.spelling)}>spelling: {LABELS[reviewStatus.spelling]}</span>{' '}
      <span className={badgeClass(reviewStatus.definition)}>definition: {LABELS[reviewStatus.definition]}</span>{' '}
      <span className={badgeClass(reviewStatus.etymology)}>etymology: {LABELS[reviewStatus.etymology]}</span>
    </>
  );
}
