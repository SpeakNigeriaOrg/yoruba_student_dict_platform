// speakers.ts
//
// speakers is a distinct identity from users - a speaker can exist with
// no login of its own (db/migrations/0001_initial_schema.sql's own
// comment). For this app's recording flow, every authenticated user gets
// (or already has) exactly one speakers row of their own, upserted by
// user_id the same way resolveUser upserts a users row by username.

import type { Queryable } from './db.js';

// No unique constraint on speakers.user_id (the schema allows a null
// user_id, so one wasn't added) - two truly concurrent first-submissions
// from the same brand-new user could each insert their own row. Accepted
// as a low-real-world-risk gap given this app's actual usage pattern (one
// curator/volunteer recording sequentially), not worth a migration change
// for.
export async function getOrCreateSpeakerForUser(client: Queryable, userId: string, displayName: string): Promise<string> {
  const existing = await client.query<{ speaker_id: string }>('select speaker_id from speakers where user_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0].speaker_id;

  const inserted = await client.query<{ speaker_id: string }>(
    'insert into speakers (display_name, user_id) values ($1, $2) returning speaker_id',
    [displayName, userId],
  );
  return inserted.rows[0].speaker_id;
}
