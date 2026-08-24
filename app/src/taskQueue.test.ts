import { describe, expect, it } from 'vitest';
import type { AssignmentSummary, AxisDecided } from './api.js';
import {
  buildTaskQueue,
  completedTaskCount,
  nextAxisForWord,
  nextTask,
  skippedTaskCount,
  taskKey,
  totalTaskCount,
} from './taskQueue.js';

function assignment(wordId: string, axisDecided: Partial<AxisDecided> = {}): AssignmentSummary {
  return {
    wordId,
    displayText: `display_${wordId}`,
    syllables: [wordId],
    definition: `def_${wordId}`,
    entryType: null,
    assignedAt: '2026-08-01T00:00:00.000Z',
    axisDecided: { entry: false, etymology: false, audio: false, audioDiverges: false, example: false, ...axisDecided },
  };
}

describe('buildTaskQueue', () => {
  it('returns nothing for no assignments', () => {
    expect(buildTaskQueue([])).toEqual([]);
  });

  it('emits one task per pending axis, entry first', () => {
    const queue = buildTaskQueue([assignment('w1')]);
    expect(queue.map((t) => t.axis)).toEqual(['entry', 'etymology', 'audio', 'example']);
  });

  it('skips axes already done', () => {
    const queue = buildTaskQueue([assignment('w1', { entry: true, audio: true })]);
    expect(queue.map((t) => t.axis)).toEqual(['etymology', 'example']);
  });

  it('omits a fully-done word entirely', () => {
    const queue = buildTaskQueue([assignment('w1', { entry: true, etymology: true, audio: true, example: true })]);
    expect(queue).toEqual([]);
  });

  it('preserves the server\'s assignment order across words', () => {
    const queue = buildTaskQueue([
      assignment('w1', { entry: true, etymology: true, example: true }),
      assignment('w2', { etymology: true, audio: true, example: true }),
    ]);
    expect(queue.map((t) => `${t.wordId}:${t.axis}`)).toEqual(['w1:audio', 'w2:entry']);
  });

  it('carries the word context each task needs to render', () => {
    const [task] = buildTaskQueue([assignment('w1')]);
    expect(task).toEqual({ wordId: 'w1', displayText: 'display_w1', definition: 'def_w1', axis: 'entry' });
  });
});

describe('progress counting', () => {
  it('counts every axis of every assigned word, done or not', () => {
    // The denominator must not shrink as work completes, or the UI reads as
    // making no progress.
    // Four axes per word now: entry, etymology, audio, example.
    const assignments = [assignment('w1', { entry: true }), assignment('w2')];
    expect(totalTaskCount(assignments)).toBe(8);
    expect(completedTaskCount(assignments)).toBe(1);
  });

  it('reports everything complete when nothing is pending', () => {
    const assignments = [assignment('w1', { entry: true, etymology: true, audio: true, example: true })];
    expect(totalTaskCount(assignments)).toBe(4);
    expect(completedTaskCount(assignments)).toBe(4);
    expect(buildTaskQueue(assignments)).toEqual([]);
  });
});

describe('nextTask', () => {
  it('returns null when the queue is empty', () => {
    expect(nextTask([])).toBeNull();
    expect(nextTask([assignment('w1', { entry: true, etymology: true, audio: true, example: true })])).toBeNull();
  });

  it('returns the head of the queue with no preference', () => {
    expect(nextTask([assignment('w1'), assignment('w2')])?.wordId).toBe('w1');
  });

  it('stays on the current word when it still has pending axes', () => {
    // Finishing w2's entry axis should advance to w2's etymology, not jump
    // back to w1.
    const assignments = [assignment('w1'), assignment('w2', { entry: true })];
    const task = nextTask(assignments, 'w2');
    expect(task).toMatchObject({ wordId: 'w2', axis: 'etymology' });
  });

  it('moves on once the preferred word is finished', () => {
    const assignments = [assignment('w1'), assignment('w2', { entry: true, etymology: true, audio: true, example: true })];
    expect(nextTask(assignments, 'w2')?.wordId).toBe('w1');
  });
});

describe('nextAxisForWord', () => {
  const decided = (over: Partial<AxisDecided> = {}): AxisDecided => ({
    entry: false,
    etymology: false,
    audio: false,
    audioDiverges: false,
    example: false,
    ...over,
  });

  it('moves from a decided entry to etymology', () => {
    expect(nextAxisForWord(decided({ entry: true }), 'entry')).toBe('etymology');
  });

  it('skips an axis that is already done', () => {
    expect(nextAxisForWord(decided({ entry: true, etymology: true }), 'entry')).toBe('audio');
  });

  it('returns null when the word is finished, so the caller stays put', () => {
    expect(nextAxisForWord(decided({ entry: true, etymology: true, audio: true, example: true }), 'entry')).toBeNull();
  });

  it('never offers the axis just decided, even if it somehow reads as pending', () => {
    // The submission succeeded (this is only called on success), so re-offering the same
    // axis would be a loop rather than a next step.
    expect(nextAxisForWord(decided({ etymology: true, audio: true, example: true }), 'entry')).toBeNull();
  });

  it('sends a finished audio axis on to the example', () => {
    expect(nextAxisForWord(decided({ entry: true, etymology: true, audio: true }), 'audio')).toBe('example');
  });

  it('follows AXIS_ORDER rather than "whatever comes after", sending a pending entry first', () => {
    // Entry first is a dependency, not a preference: a spelling change invalidates
    // recordings and re-matches components.
    expect(nextAxisForWord(decided({ etymology: true }), 'etymology')).toBe('entry');
  });
});

// Setting a task aside for the session. The defect this covers: "Skip for now" was wired to
// the post-submit advance(), which only re-derives from server state - and a skip changes no
// server state, so the identical task came back every time.
describe('skipping', () => {
  const skips = (...keys: string[]) => new Set(keys);

  it('withholds the skipped axis and leaves the rest of the word', () => {
    const queue = buildTaskQueue([assignment('w1')], { skipped: skips(taskKey('w1', 'audio')) });
    expect(queue.map((t) => t.axis)).toEqual(['entry', 'etymology', 'example']);
  });

  it('hands over the same word\'s next axis rather than jumping to another word', () => {
    const assignments = [assignment('w1'), assignment('w2')];
    const task = nextTask(assignments, 'w1', { skipped: skips(taskKey('w1', 'entry')) });
    expect(task).toMatchObject({ wordId: 'w1', axis: 'etymology' });
  });

  it('moves to the next word once every axis of this one is set aside', () => {
    const assignments = [assignment('w1'), assignment('w2')];
    const skipped = skips(...(['entry', 'etymology', 'audio', 'example'] as const).map((a) => taskKey('w1', a)));
    expect(nextTask(assignments, 'w1', { skipped })).toMatchObject({ wordId: 'w2', axis: 'entry' });
  });

  it('returns null when everything pending is set aside', () => {
    const assignments = [assignment('w1', { entry: true, etymology: true, example: true })];
    expect(nextTask(assignments, 'w1', { skipped: skips(taskKey('w1', 'audio')) })).toBeNull();
  });

  it('leaves progress counts untouched - a task set aside is not a task done', () => {
    // The regression guard for the progress bar. Excluding skips from completedTaskCount
    // would make the bar claim work that has not happened, which is the same class of lie
    // the dead Skip button was already telling.
    const assignments = [assignment('w1'), assignment('w2')];
    const skipped = skips(taskKey('w1', 'entry'), taskKey('w1', 'audio'));
    expect(totalTaskCount(assignments)).toBe(8);
    expect(completedTaskCount(assignments)).toBe(0);
    expect(buildTaskQueue(assignments, { skipped })).toHaveLength(6);
  });

  it('counts only skips that still name pending work', () => {
    // A key outlives what it names: skip a task, then finish it from "My whole list", and
    // the count must not keep offering to bring back something already done.
    const assignments = [assignment('w1', { audio: true })];
    const skipped = skips(taskKey('w1', 'audio'), taskKey('w1', 'entry'), taskKey('w9', 'entry'));
    expect(skippedTaskCount(assignments, skipped)).toBe(1);
  });

  it('counts nothing when nothing is skipped', () => {
    expect(skippedTaskCount([assignment('w1')], new Set())).toBe(0);
  });
});
