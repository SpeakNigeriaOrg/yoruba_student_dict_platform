// screens/TaskQueue.tsx
//
// The volunteer's landing screen, replacing AssignmentsList as the default.
//
// The old flow asked a phone user to navigate: read a list of assigned
// words, pick one, pick one of the axis tabs, then work a dense form. This
// hands over one task instead - the next unfinished (word, axis) pair - and
// advances on submit. The list is still reachable (see "My whole list"
// below, and the bottom nav for curators); it just isn't the thing you have
// to work through to get to the work.
//
// The queue derives from the existing GET /api/assignments/me response,
// which already returns axisDecided per word - no new endpoint. Ordering and
// progress live in taskQueue.ts, pure and unit-tested.

import { useCallback, useEffect, useState } from 'react';
import { getMyAssignments, type AssignmentSummary } from '../api.js';
import {
  buildTaskQueue,
  completedTaskCount,
  nextTask,
  skippedTaskCount,
  taskKey,
  totalTaskCount,
  type Task,
} from '../taskQueue.js';
import { useSkippedTasks } from '../skippedTasks.js';
import { AssignmentsList } from './AssignmentsList.js';
import { WordReview } from './WordReview.js';

const AXIS_TASK_LABEL: Record<Task['axis'], string> = {
  entry: 'Confirm the spelling and meaning',
  etymology: 'Check the word parts',
  audio: 'Record this word',
  example: 'Show the word in use',
};

export interface TaskQueueProps {
  isCurator: boolean;
  /** Lets the queue hand off to the normal word screen, so a task opened
   * from here is deep-linkable and the back gesture behaves. */
  onOpenWord: (wordId: string, axis: Task['axis']) => void;
}

export function TaskQueue({ isCurator, onOpenWord }: TaskQueueProps) {
  const [assignments, setAssignments] = useState<AssignmentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  // The word currently being worked, so finishing its entry axis advances to
  // its etymology rather than jumping to an unrelated word.
  const [currentWordId, setCurrentWordId] = useState<string | null>(null);
  const { skipped, skip, restoreAll } = useSkippedTasks();

  const load = useCallback(async () => {
    try {
      const result = await getMyAssignments();
      setAssignments(result);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** After a real submit. The server state changed, so it has to be re-read - which is
   * the whole difference between this and skipCurrent below, and the reason the two are
   * no longer the same function. Sharing one handler is what made Skip a no-op: it
   * re-derived the next task from server data a skip had not changed, and handed back
   * the identical one. */
  async function advance() {
    const refreshed = await load();
    if (!refreshed) return;
    const task = nextTask(refreshed, currentWordId, { skipped });
    setCurrentWordId(task?.wordId ?? null);
  }

  /** Sets one (word, axis) aside for this session.
   *
   * No re-fetch: nothing was submitted, so there is nothing new to read, and asking makes
   * the button slower for no answer. The next render derives the task from the same
   * assignments with the enlarged skip set, which is what actually moves it on.
   *
   * currentWordId stays on this word deliberately - skipping "Record this word" should
   * offer that word's next unfinished axis, not jump to an unrelated word. The task just
   * skipped is excluded, so preferring the word can no longer re-serve it. */
  function skipCurrent(task: Task) {
    skip(taskKey(task.wordId, task.axis));
    setCurrentWordId(task.wordId);
  }

  if (error)
    return (
      <p role="alert" className="error-banner">
        Couldn't load your tasks: {error}
      </p>
    );
  if (!assignments) return <p>Loading your tasks...</p>;

  // Two queues, and the difference between them is the point: `pending` is what is still
  // owed (the truth behind progress), `offered` is what the volunteer is handed next.
  const pending = buildTaskQueue(assignments);
  const offered = buildTaskQueue(assignments, { skipped });
  const total = totalTaskCount(assignments);
  const done = completedTaskCount(assignments);
  const setAside = skippedTaskCount(assignments, skipped);

  if (assignments.length === 0) {
    return (
      <section aria-label="Task queue">
        <p>No words assigned to you right now.</p>
      </section>
    );
  }

  if (pending.length === 0) {
    return (
      <section aria-label="Task queue">
        <h2>All caught up</h2>
        <p>
          Every one of your {assignments.length} assigned word{assignments.length === 1 ? '' : 's'} is done - {done} of{' '}
          {total} tasks complete.
        </p>
        <button type="button" className="btn btn-secondary" onClick={() => setShowList((s) => !s)}>
          {showList ? 'Hide my list' : 'My whole list'}
        </button>
        {showList ? (
          <AssignmentsList assignments={assignments} onSelect={(wordId) => onOpenWord(wordId, 'entry')} />
        ) : null}
      </section>
    );
  }

  // Everything left is set aside. Said plainly, with the way back, rather than showing
  // "All caught up" for work that is still owed.
  if (offered.length === 0) {
    return (
      <section aria-label="Task queue">
        <h2>Nothing left but what you set aside</h2>
        <p>
          You skipped {setAside} task{setAside === 1 ? '' : 's'} this session. {done} of {total} tasks are done.
        </p>
        <button type="button" className="btn btn-primary" onClick={restoreAll}>
          Bring back skipped tasks
        </button>{' '}
        <button type="button" className="btn btn-secondary" onClick={() => setShowList((s) => !s)}>
          {showList ? 'Hide my list' : 'My whole list'}
        </button>
        {showList ? (
          <AssignmentsList assignments={assignments} onSelect={(wordId) => onOpenWord(wordId, 'entry')} />
        ) : null}
      </section>
    );
  }

  // No `?? offered[0]` fallback: nextTask is given the same skip set, so a null here would
  // mean the queue is empty, which the branch above has already handled. Falling back
  // would re-serve a task the volunteer had just set aside.
  const task = nextTask(assignments, currentWordId, { skipped })!;

  return (
    <section aria-label="Task queue">
      <div className="queue-header">
        {/* A POSITION, not a completion count - tasks moved past include the ones set
            aside. The BAR below stays on `done` alone, because a skipped task is not
            work that happened and the bar is the only honest picture of how much is. */}
        <p className="queue-progress" aria-label="Queue progress">
          Task {done + setAside + 1} of {total}
        </p>
        <div className="progress-track" role="presentation">
          <div className="progress-fill" style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
        </div>
        {setAside > 0 ? (
          <p className="field-note" aria-label="Skipped tasks">
            {setAside} set aside for now.{' '}
            <button type="button" className="btn btn-link" onClick={restoreAll}>
              Bring them back
            </button>
          </p>
        ) : null}
        <p className="queue-task-label">{AXIS_TASK_LABEL[task.axis]}</p>
        {/* Reachable without scrolling past the whole task.
          *
          * The queue is the root view, so there is nothing to go "back" to from
          * here - which is why only the word screen carries a Back button. But
          * that left a volunteer with no navigation at all until they scrolled to
          * the bottom of the longest screen in the app, and volunteers get no
          * bottom nav either. The list is the way to revisit a word already done,
          * or to jump ahead, so it belongs at the top. */}
        <button type="button" className="btn btn-secondary queue-list-toggle" onClick={() => setShowList((s) => !s)}>
          {showList ? 'Hide my list' : 'My whole list'}
        </button>
        {showList ? (
          <AssignmentsList assignments={assignments} onSelect={(wordId) => onOpenWord(wordId, 'entry')} />
        ) : null}
      </div>

      <WordReview
        wordId={task.wordId}
        axis={task.axis}
        isCurator={isCurator}
        // Switching axis inside the queue opens that word properly rather
        // than silently retargeting the queue - the tab bar is navigation,
        // not a queue control.
        onAxisChange={(axis) => onOpenWord(task.wordId, axis)}
        onDecided={() => void advance()}
        // The queue already chose this task and says so above. Tabs here would
        // invite the navigation the queue exists to remove.
        showAxisTabs={false}
      />

      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={() => skipCurrent(task)}>
          Skip for now
        </button>
      </div>
    </section>
  );
}
