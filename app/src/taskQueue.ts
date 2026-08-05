// taskQueue.ts
//
// Turns "my assigned words" into a flat, ordered list of individual tasks -
// the data behind the one-task-at-a-time flow that replaced list-then-tabs
// navigation as the volunteer's landing screen.
//
// Deliberately pure and derived from the EXISTING GET /api/assignments/me
// response, which already returns axisDecided per word. No new endpoint: the
// flattening is a view concern, one round trip already covers it, and putting
// it here keeps it testable without a DOM (same split as shared/src/* and
// app/src/audio/*).
//
// Ordering is assignment order (the server's own, so a curator's intent is
// preserved), and within one word: entry -> etymology -> audio. Entry first
// because both of the others depend on it in practice - a spelling change
// invalidates recordings (see scripts/publishToR2.mjs's
// recorded_display_text check), and etymology components are matched against
// the decided spelling.

import type { AssignmentSummary, AxisDecided } from './api.js';
import type { Axis } from './route.js';

export interface Task {
  wordId: string;
  displayText: string;
  definition: string | null;
  axis: Axis;
}

/** Axis order within a single word. Also the order the tab bar shows. */
const AXIS_ORDER: readonly Axis[] = ['entry', 'etymology', 'audio'];

function isPending(axisDecided: AxisDecided, axis: Axis): boolean {
  return !axisDecided[axis];
}

/** Every not-yet-done (word, axis) pair the caller still owes work on.
 *
 * Note that `audio` is per-user by design (api/src/reviewShared.ts's
 * AxisDecided.audio) - so an audio task appears for a word someone ELSE
 * already recorded, which is intended: every participant records every word
 * themselves. */
export function buildTaskQueue(assignments: AssignmentSummary[]): Task[] {
  const tasks: Task[] = [];
  for (const assignment of assignments) {
    for (const axis of AXIS_ORDER) {
      if (isPending(assignment.axisDecided, axis)) {
        tasks.push({
          wordId: assignment.wordId,
          displayText: assignment.displayText,
          definition: assignment.definition,
          axis,
        });
      }
    }
  }
  return tasks;
}

/** Total tasks across all assigned words, done and pending, for honest
 * progress ("task 3 of 12"). Counting only pending ones would make the
 * denominator shrink as the user works, which reads as no progress at all. */
export function totalTaskCount(assignments: AssignmentSummary[]): number {
  return assignments.length * AXIS_ORDER.length;
}

export function completedTaskCount(assignments: AssignmentSummary[]): number {
  return totalTaskCount(assignments) - buildTaskQueue(assignments).length;
}

/** The task to hand over next, preferring to stay on the word the user is
 * already looking at so finishing its entry axis moves to its etymology
 * rather than jumping to a different word. Returns null when nothing is left.
 */
export function nextTask(assignments: AssignmentSummary[], preferWordId?: string | null): Task | null {
  const queue = buildTaskQueue(assignments);
  if (queue.length === 0) return null;
  if (preferWordId) {
    const onSameWord = queue.find((t) => t.wordId === preferWordId);
    if (onSameWord) return onSameWord;
  }
  return queue[0];
}
