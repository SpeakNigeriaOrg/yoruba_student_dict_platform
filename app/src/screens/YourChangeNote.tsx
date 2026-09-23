// YourChangeNote.tsx
//
// The small marker shown wherever a volunteer sees a word they have corrected. Every screen shows
// them the word as THEY said it is (see api/src/myEntryAnswer.ts); this line is only there so a
// change made by accident gets noticed. Deliberately one quiet line, not a banner: the volunteer
// is not being asked to reconcile two versions of the word, they are being reminded which of their
// own edits they made.

import type { MyEntryAnswer } from '../api.js';

export function YourChangeNote({ answer }: { answer: MyEntryAnswer | null | undefined }) {
  if (!answer || (!answer.spellingChanged && !answer.definitionChanged)) return null;
  const parts: string[] = [];
  if (answer.spellingChanged) parts.push(`spelling (was ${answer.recordDisplayText})`);
  if (answer.definitionChanged) parts.push(`definition (was ${answer.recordDefinition ?? 'blank'})`);
  return (
    <p className="field-note your-change" aria-label="Your change">
      ✎ You changed this word&apos;s {parts.join(' and ')}.
    </p>
  );
}
