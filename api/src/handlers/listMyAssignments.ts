// handlers/listMyAssignments.ts
//
// Backs GET /assignments/me - the calling user's assigned word_id batch,
// joined with golden_record for the fields a "my assignments" screen
// actually needs to render (any authenticated user - curators additionally
// get a bulk view via /assignments/* per staticwebapp.config.json, not
// implemented yet).

import type { Queryable } from '../db.js';

export interface AssignmentSummary {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  assignedAt: Date;
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
  return result.rows.map((row) => ({
    wordId: row.word_id,
    displayText: row.display_text,
    syllables: row.syllables,
    definition: row.definition,
    entryType: row.entry_type,
    assignedAt: row.assigned_at,
  }));
}
