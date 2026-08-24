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
// preserved), and within one word: entry -> etymology -> audio -> example. Entry
// first because the others depend on it in practice - a spelling change
// invalidates recordings (see scripts/publishToR2.mjs's
// recorded_display_text check), and etymology components are matched against
// the decided spelling. Example last because it is the only generative task:
// illustrating a word is easiest once you have read it, checked its parts, and
// said it aloud.
//
// A SKIP is a client-session exclusion laid over that same ordering, never a server
// state - see skippedTasks.ts. It changes what is offered, and deliberately nothing
// about assignment order, axis order, or what counts as done.

import type { AssignmentSummary, AxisDecided } from './api.js';
import type { Axis } from './route.js';

export interface Task {
  wordId: string;
  displayText: string;
  definition: string | null;
  axis: Axis;
}

/** Axis order within a single word. Also the order the tab bar shows. */
export const AXIS_ORDER: readonly Axis[] = ['entry', 'etymology', 'audio', 'example'];

function isPending(axisDecided: AxisDecided, axis: Axis): boolean {
  return !axisDecided[axis];
}

/** Identifies one (word, axis) pair - the unit a skip applies to.
 *
 * ':' is unambiguous as a separator because a word_id cannot contain one:
 * api/src/handlers/wordIdShape.ts's WORD_ID_PATTERN admits only [a-z0-9_-]. */
export type TaskKey = string;

export function taskKey(wordId: string, axis: Axis): TaskKey {
  return `${wordId}:${axis}`;
}

export interface QueueOptions {
  /** Tasks the user has set aside for this session (skippedTasks.ts).
   *
   * Excluded from what is OFFERED and deliberately not from what is DONE - see
   * completedTaskCount. */
  skipped?: ReadonlySet<TaskKey>;
}

/** Every not-yet-done (word, axis) pair the caller still owes work on.
 *
 * Note that `audio` is per-user by design (api/src/reviewShared.ts's
 * AxisDecided.audio) - so an audio task appears for a word someone ELSE
 * already recorded, which is intended: every participant records every word
 * themselves. */
export function buildTaskQueue(assignments: AssignmentSummary[], options: QueueOptions = {}): Task[] {
  const tasks: Task[] = [];
  for (const assignment of assignments) {
    for (const axis of AXIS_ORDER) {
      if (!isPending(assignment.axisDecided, axis)) continue;
      if (options.skipped?.has(taskKey(assignment.wordId, axis))) continue;
      tasks.push({
        wordId: assignment.wordId,
        displayText: assignment.displayText,
        definition: assignment.definition,
        axis,
      });
    }
  }
  return tasks;
}

/** The next axis of ONE word that still needs work, or null when the word is finished.
 *
 * Used when a word is opened directly (Browse, the review queue, a user's assignment
 * list) rather than handed over by the queue: deciding an axis there should move on to
 * the next one, the same as it does inside the queue. Before this, confirming on the
 * word route left you on the axis you had just finished, with the tab bar as the only
 * way forward.
 *
 * Ordered by AXIS_ORDER, not "whatever comes after the current axis", so a word whose
 * entry is somehow still pending sends you back to entry - which is the dependency
 * order the queue itself follows, and the reason it exists (a spelling change
 * invalidates recordings and re-matches components).
 *
 * The current axis is excluded: it has just been decided, and on the rare path where
 * the decision did not register there is nothing useful about offering it again. */
export function nextAxisForWord(axisDecided: AxisDecided, currentAxis: Axis): Axis | null {
  return AXIS_ORDER.find((axis) => axis !== currentAxis && isPending(axisDecided, axis)) ?? null;
}

/** Total tasks across all assigned words, done and pending, for honest
 * progress ("task 3 of 12"). Counting only pending ones would make the
 * denominator shrink as the user works, which reads as no progress at all. */
export function totalTaskCount(assignments: AssignmentSummary[]): number {
  return assignments.length * AXIS_ORDER.length;
}

/** Deliberately called WITHOUT a skip set: setting a task aside is not finishing it, and
 * counting it as done would make the progress bar say the work happened. The skipped
 * count is reported separately (skippedTaskCount) so a volunteer can see both. */
export function completedTaskCount(assignments: AssignmentSummary[]): number {
  return totalTaskCount(assignments) - buildTaskQueue(assignments).length;
}

/** How many still-pending tasks are currently set aside.
 *
 * Intersected with the pending queue rather than read off the set's size, because a key
 * outlives what it names: a task skipped here and then completed from "My whole list", or
 * belonging to a word since unassigned, must not inflate the count and leave the screen
 * offering to bring back something that no longer exists. */
export function skippedTaskCount(assignments: AssignmentSummary[], skipped: ReadonlySet<TaskKey>): number {
  if (skipped.size === 0) return 0;
  return buildTaskQueue(assignments).filter((t) => skipped.has(taskKey(t.wordId, t.axis))).length;
}

/** The task to hand over next, preferring to stay on the word the user is
 * already looking at so finishing its entry axis moves to its etymology
 * rather than jumping to a different word. Returns null when nothing is left.
 */
export function nextTask(
  assignments: AssignmentSummary[],
  preferWordId?: string | null,
  options: QueueOptions = {},
): Task | null {
  const queue = buildTaskQueue(assignments, options);
  if (queue.length === 0) return null;
  if (preferWordId) {
    const onSameWord = queue.find((t) => t.wordId === preferWordId);
    if (onSameWord) return onSameWord;
  }
  return queue[0];
}
