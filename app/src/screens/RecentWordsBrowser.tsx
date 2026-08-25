// screens/RecentWordsBrowser.tsx
//
// "We just added a batch of words; assign all of them." The newest entries,
// grouped under the day they were added, each day with its own select-all.
//
// WHY A BROWSE AND NOT A THIRD SHORTCUT. WordAssignPicker's other two bulk
// options (all words / all incomplete words) hand a scope to the server and
// never name a word: the set is resolved at submit time so it cannot go stale,
// and a two-step confirm stands in for seeing what you are about to do. Neither
// applies here. "Recent" is a judgement - the curator is looking for the
// boundary of a batch they remember adding - so the whole value is in seeing
// the list, and what they picked leaves as explicit word_ids.
//
// GROUPED BY DAY, because that is the shape a batch actually has. An import or
// an afternoon of Add Word lands on one date, so "Select all 47 from today" is
// usually the entire question. The grouping is done on the client from
// createdAt: it is a presentation of the same rows either way, and the
// browser's timezone is the one the curator's memory of "yesterday" is in.
//
// The newest day starts selected. It is the batch just added in the common
// case, it is visible and unticks in one click, and nothing is assigned until
// the picker's own Assign button is pressed - so the default is a suggestion,
// not an action.

import { useEffect, useMemo, useState } from 'react';
import { getRecentWords, type RecentWordSummary } from '../api.js';

export interface RecentWordsBrowserProps {
  /** Whose assignments the alreadyAssigned flags are about - the user being
   * looked at, not the curator looking. */
  userId: string;
  /** Hands the checked word_ids back to WordAssignPicker's pending list rather
   * than assigning them here, so there stays exactly one Assign button and one
   * place that reports created/alreadyAssigned. */
  onAddSelected: (wordIds: string[]) => void;
  onClose: () => void;
}

interface DayGroup {
  /** yyyy-mm-dd in the viewer's timezone; the grouping key, not the label. */
  key: string;
  label: string;
  words: RecentWordSummary[];
}

/** Local-calendar-day key. Deliberately not createdAt.slice(0, 10): that is the
 * UTC day, which puts anything a curator added after their evening cutoff into
 * "tomorrow" - the one thing this grouping exists to get right. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayLabel(date: Date, now: Date): string {
  const key = dayKey(date);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Exported for its own test: the server already returns newest-first, so this
 * only has to preserve that order rather than re-sort. */
export function groupByDay(words: RecentWordSummary[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const word of words) {
    const created = new Date(word.createdAt);
    const key = dayKey(created);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.words.push(word);
    else groups.push({ key, label: dayLabel(created, now), words: [word] });
  }
  return groups;
}

export function RecentWordsBrowser({ userId, onAddSelected, onClose }: RecentWordsBrowserProps) {
  const [words, setWords] = useState<RecentWordSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    getRecentWords(userId)
      .then((loaded) => {
        if (!live) return;
        setWords(loaded);
        // Pre-select the newest day's still-unassigned words. Computed from the
        // response rather than in a second effect, so there is no render where
        // the list is up and the default has not been applied yet.
        const groups = groupByDay(loaded, new Date());
        const newest = groups[0];
        setSelected(new Set(newest ? newest.words.filter((w) => !w.alreadyAssigned).map((w) => w.wordId) : []));
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [userId]);

  const groups = useMemo(() => (words ? groupByDay(words, new Date()) : []), [words]);

  function toggle(wordId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(wordId)) next.delete(wordId);
      else next.add(wordId);
      return next;
    });
  }

  function setGroupSelected(group: DayGroup, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const word of group.words) {
        if (word.alreadyAssigned) continue;
        if (on) next.add(word.wordId);
        else next.delete(word.wordId);
      }
      return next;
    });
  }

  function selectableOf(group: DayGroup) {
    return group.words.filter((w) => !w.alreadyAssigned);
  }

  function handleAdd() {
    // Emitted in the displayed (newest-first) order rather than the Set's
    // insertion order, so the pending chips read the same way the list did.
    const ordered = (words ?? []).filter((w) => selected.has(w.wordId)).map((w) => w.wordId);
    if (ordered.length === 0) return;
    onAddSelected(ordered);
    onClose();
  }

  return (
    <div className="field">
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close recently added
        </button>
      </div>

      {error ? <p role="alert" className="error-banner">Couldn't load recently added words: {error}</p> : null}

      {!words ? (
        error ? null : <p>Loading recently added words...</p>
      ) : words.length === 0 ? (
        <p>No words have been added yet.</p>
      ) : (
        <>
          {groups.map((group) => {
            const selectable = selectableOf(group);
            const allOn = selectable.length > 0 && selectable.every((w) => selected.has(w.wordId));
            return (
              <div key={group.key}>
                <h3>
                  {group.label} — {group.words.length} word(s)
                </h3>
                {selectable.length > 0 ? (
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setGroupSelected(group, !allOn)}
                    >
                      {allOn ? `Clear ${group.label}` : `Select all ${selectable.length} from ${group.label}`}
                    </button>
                  </div>
                ) : null}
                <ul aria-label={`Words added ${group.label}`} className="plain-list">
                  {group.words.map((word) => (
                    <li key={word.wordId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(word.wordId)}
                          disabled={word.alreadyAssigned}
                          onChange={() => toggle(word.wordId)}
                        />{' '}
                        {word.displayText} ({word.wordId})
                        {word.definition ? <span> — {word.definition}</span> : null}
                        {/* Shown rather than hidden: a curator checking whether the
                            batch landed needs to see the words that are already
                            there, not wonder where they went. */}
                        {word.alreadyAssigned ? <span> — already assigned</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={handleAdd} disabled={selected.size === 0}>
              Add {selected.size} selected word(s)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
