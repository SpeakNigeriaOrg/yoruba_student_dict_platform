import { describe, expect, it } from 'vitest';
import type { AssignmentSummary, AxisDecided } from './api.js';
import { buildTaskQueue, completedTaskCount, nextTask, totalTaskCount } from './taskQueue.js';

function assignment(wordId: string, axisDecided: Partial<AxisDecided> = {}): AssignmentSummary {
  return {
    wordId,
    displayText: `display_${wordId}`,
    syllables: [wordId],
    definition: `def_${wordId}`,
    entryType: null,
    assignedAt: '2026-08-01T00:00:00.000Z',
    axisDecided: { entry: false, etymology: false, audio: false, ...axisDecided },
  };
}

describe('buildTaskQueue', () => {
  it('returns nothing for no assignments', () => {
    expect(buildTaskQueue([])).toEqual([]);
  });

  it('emits one task per pending axis, entry first', () => {
    const queue = buildTaskQueue([assignment('w1')]);
    expect(queue.map((t) => t.axis)).toEqual(['entry', 'etymology', 'audio']);
  });

  it('skips axes already done', () => {
    const queue = buildTaskQueue([assignment('w1', { entry: true, audio: true })]);
    expect(queue.map((t) => t.axis)).toEqual(['etymology']);
  });

  it('omits a fully-done word entirely', () => {
    const queue = buildTaskQueue([assignment('w1', { entry: true, etymology: true, audio: true })]);
    expect(queue).toEqual([]);
  });

  it('preserves the server\'s assignment order across words', () => {
    const queue = buildTaskQueue([
      assignment('w1', { entry: true, etymology: true }),
      assignment('w2', { etymology: true, audio: true }),
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
    const assignments = [assignment('w1', { entry: true }), assignment('w2')];
    expect(totalTaskCount(assignments)).toBe(6);
    expect(completedTaskCount(assignments)).toBe(1);
  });

  it('reports everything complete when nothing is pending', () => {
    const assignments = [assignment('w1', { entry: true, etymology: true, audio: true })];
    expect(totalTaskCount(assignments)).toBe(3);
    expect(completedTaskCount(assignments)).toBe(3);
    expect(buildTaskQueue(assignments)).toEqual([]);
  });
});

describe('nextTask', () => {
  it('returns null when the queue is empty', () => {
    expect(nextTask([])).toBeNull();
    expect(nextTask([assignment('w1', { entry: true, etymology: true, audio: true })])).toBeNull();
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
    const assignments = [assignment('w1'), assignment('w2', { entry: true, etymology: true, audio: true })];
    expect(nextTask(assignments, 'w2')?.wordId).toBe('w1');
  });
});
