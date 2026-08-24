// skippedTasks.ts
//
// The set of tasks a volunteer has set aside for now.
//
// ---------------------------------------------------------------------------
// Why this exists at all
// ---------------------------------------------------------------------------
// "Skip for now" did nothing. It was wired to TaskQueue's advance(), the same function
// used after a real submit, which only re-reads GET /api/assignments/me and re-derives
// the next task. A skip submits nothing, so the server's axisDecided was unchanged and
// the identical (word, axis) came straight back. Worse, the first click set
// currentWordId, and nextTask PREFERS that word - so the one control for getting past a
// task actively pinned you to it. There was no skip state anywhere in the app; the
// concept had never been implemented.
//
// ---------------------------------------------------------------------------
// Why sessionStorage rather than useState
// ---------------------------------------------------------------------------
// TaskQueue unmounts whenever it hands off to the word route - which its own "My whole
// list" rows do, and so does the axis tab bar. Holding the set in component state would
// therefore lose every skip the moment a volunteer opened a word and came back, and the
// task they had just set aside would be waiting for them. That is close enough to the
// original bug to be indistinguishable from it.
//
// sessionStorage is also exactly the lifetime the button promises. "For now" means this
// sitting: the set is per-tab and disappears when the tab closes, so nothing is quietly
// withheld from someone's queue tomorrow. Persisting it server-side would need a table
// and an endpoint to express something nobody asked to be permanent.
//
// This is the first storage use in app/src. It is deliberately confined to this file, so
// there is one place to change if the answer ever becomes a real endpoint.

import { useCallback, useState } from 'react';
import type { TaskKey } from './taskQueue.js';

const STORAGE_KEY = 'yoruba.skippedTasks';

/** Storage can throw outright, not merely return null - Safari's private mode and a
 * browser set to block site data both do. A volunteer who cannot persist skips should
 * still get skips that work for as long as the screen stays mounted, so every access is
 * guarded and failure degrades to an in-memory set. */
function readStored(): Set<TaskKey> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

function writeStored(keys: ReadonlySet<TaskKey>): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Ignored on purpose - see readStored. The in-memory set below is still correct.
  }
}

export interface SkippedTasks {
  skipped: ReadonlySet<TaskKey>;
  skip: (key: TaskKey) => void;
  /** Puts every set-aside task back in the queue. The escape hatch that keeps skipping
   * from being a one-way door - see TaskQueue's "Bring them back". */
  restoreAll: () => void;
}

export function useSkippedTasks(): SkippedTasks {
  const [skipped, setSkipped] = useState<ReadonlySet<TaskKey>>(readStored);

  const skip = useCallback((key: TaskKey) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      next.add(key);
      writeStored(next);
      return next;
    });
  }, []);

  const restoreAll = useCallback(() => {
    const empty = new Set<TaskKey>();
    writeStored(empty);
    setSkipped(empty);
  }, []);

  return { skipped, skip, restoreAll };
}
