// handlers/listMyAssignments.ts
//
// Backs GET /assignments/me - the calling user's assigned word_id batch,
// joined with golden_record for the fields a "my assignments" screen
// actually needs to render (any authenticated user - curators additionally
// get a bulk view via /assignments/* per staticwebapp.config.json, not
// implemented yet).

import type { Queryable } from '../db.js';
import { loadAxisDecidedBatch, type AxisDecided } from '../reviewShared.js';

export interface AssignmentSummary {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  assignedAt: Date;
  // Same per-axis status shown on the browse-all-words list, via the
  // same AxisStatusBadges component - a curator sees at a glance which
  // axes on their assigned word still need attention, not just whether
  // *someone* has already touched it.
  axisDecided: AxisDecided;
}

export async function listMyAssignments(db: Queryable, userId: string): Promise<AssignmentSummary[]> {
  const result = await db.query<{
    word_id: string;
    display_text: string;
    syllables: string[];
    definition: string | null;
    entry_type: 'phrase' | null;
    assigned_at: Date;
  }>(
    `select a.word_id, gr.display_text, gr.syllables, gr.definition, gr.entry_type, a.assigned_at
     from assignments a
     join golden_record gr on gr.word_id = a.word_id
     where a.user_id = $1
     order by a.assigned_at asc`,
    [userId],
  );
  const axisDecidedByWord = await loadAxisDecidedBatch(db, result.rows.map((row) => row.word_id), userId);
  return result.rows.map((row) => ({
    wordId: row.word_id,
    displayText: row.display_text,
    syllables: row.syllables,
    definition: row.definition,
    entryType: row.entry_type,
    assignedAt: row.assigned_at,
    axisDecided: axisDecidedByWord.get(row.word_id)!,
  }));
}
