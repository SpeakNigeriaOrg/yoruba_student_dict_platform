// handlers/listUsers.ts
//
// Backs GET /api/users - curator-only. Every user account plus a
// per-user summary of their assigned words: how many are assigned, how
// many have at least one axis in_review (and aren't fully passed yet),
// and how many have all three axes (spelling/definition/etymology)
// passed. Real gap this closes: assignments could only ever be inspected
// via direct SQL before this.

import type { Queryable } from '../db.js';

export interface UserSummary {
  userId: string;
  username: string;
  displayName: string | null;
  role: 'curator' | 'volunteer';
  assignedWordCount: number;
  inReviewCount: number;
  passedCount: number;
}

const AXES = ['spelling', 'definition', 'etymology'] as const;

export async function listUsers(client: Queryable): Promise<UserSummary[]> {
  const [users, assignments, decisions, pending] = await Promise.all([
    client.query<{ user_id: string; username: string; display_name: string | null; role: 'curator' | 'volunteer' }>(
      'select user_id, username, display_name, role from users order by username',
    ),
    client.query<{ user_id: string; word_id: string }>('select user_id, word_id from assignments'),
    client.query<{ word_id: string; axis: 'spelling' | 'definition' | 'etymology' }>(
      'select word_id, axis from word_decisions',
    ),
    client.query<{ word_id: string; submitted_by: string; axis: 'spelling' | 'definition' | 'etymology' }>(
      `select word_id, submitted_by, axis from contributions
       where status = 'pending' and axis in ('spelling', 'definition', 'etymology')`,
    ),
  ]);

  const passedAxesByWord = new Map<string, Set<string>>();
  for (const row of decisions.rows) {
    const existing = passedAxesByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else passedAxesByWord.set(row.word_id, new Set([row.axis]));
  }
  const pendingAxesByUserWord = new Map<string, Set<string>>();
  for (const row of pending.rows) {
    const key = `${row.submitted_by}:${row.word_id}`;
    const existing = pendingAxesByUserWord.get(key);
    if (existing) existing.add(row.axis);
    else pendingAxesByUserWord.set(key, new Set([row.axis]));
  }

  const assignedWordsByUser = new Map<string, string[]>();
  for (const row of assignments.rows) {
    const existing = assignedWordsByUser.get(row.user_id);
    if (existing) existing.push(row.word_id);
    else assignedWordsByUser.set(row.user_id, [row.word_id]);
  }

  return users.rows.map((user) => {
    const wordIds = assignedWordsByUser.get(user.user_id) ?? [];
    let inReviewCount = 0;
    let passedCount = 0;
    for (const wordId of wordIds) {
      const passed = passedAxesByWord.get(wordId) ?? new Set<string>();
      if (AXES.every((axis) => passed.has(axis))) {
        passedCount += 1;
        continue;
      }
      const pendingAxes = pendingAxesByUserWord.get(`${user.user_id}:${wordId}`) ?? new Set<string>();
      if (pendingAxes.size > 0) inReviewCount += 1;
    }
    return {
      userId: user.user_id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      assignedWordCount: wordIds.length,
      inReviewCount,
      passedCount,
    };
  });
}
