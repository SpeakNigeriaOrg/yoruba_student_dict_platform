// reviewShared.ts
//
// Loading logic shared by the GET .../review-axis endpoints
// (getEntryReview.ts, getEtymologyReview.ts) - factored out once a second
// consumer needed the exact same full-vocab load and per-word axis-decided
// lookup.

import {
  recordingMatchesGolden,
  recordingMatchesGoldenSql,
  type DiagnoseOverride,
  type DiagnosticsOverrides,
  type Vocab,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from './db.js';

export async function loadVocab(client: Queryable): Promise<Vocab> {
  const words = await client.query<{
    word_id: string;
    display_text: string;
    syllables: string[];
    definition: string | null;
    entry_type: 'phrase' | null;
  }>('select word_id, display_text, syllables, definition, entry_type from golden_record');
  const componentRows = await client.query<{ word_id: string; component_word_id: string }>(
    'select word_id, component_word_id from golden_record_components order by word_id, component_position',
  );
  const componentsByWord = new Map<string, string[]>();
  for (const row of componentRows.rows) {
    const existing = componentsByWord.get(row.word_id);
    if (existing) existing.push(row.component_word_id);
    else componentsByWord.set(row.word_id, [row.component_word_id]);
  }

  const vocab: Vocab = {};
  for (const row of words.rows) {
    vocab[row.word_id] = {
      displayText: row.display_text,
      syllables: row.syllables,
      ...(row.definition !== null ? { definition: row.definition } : {}),
      ...(row.entry_type === 'phrase' ? { type: 'phrase' as const } : {}),
      ...(componentsByWord.has(row.word_id) ? { components: componentsByWord.get(row.word_id) } : {}),
    };
  }
  return vocab;
}

/** The axis a word_decisions row can be on. 'spelling' and 'definition'
 * were separate axes until 0011_merge_entry_axis.sql merged them into
 * 'entry' - a word's written form is not separable from its meaning, so
 * they are decided together or not at all. */
export type DecisionAxis = 'entry' | 'etymology';

/** "Does the REQUESTING user still owe work on this axis?" - which since 0013
 * is not the same question as "is this settled".
 *
 * All three axes are now scoped to the requesting user, the rule audio has
 * always followed. entry/etymology are done for someone when a curator has
 * decided (golden, true for everyone) OR when that person has already
 * contributed their own active opinion.
 *
 * That distinction is what produces overlapping contributors: a word with one
 * volunteer's answer is NOT finished, so it keeps being offered to others,
 * while never being handed back to the person who already answered it.
 *
 * Curator surfaces that want global progress must use
 * loadGlobalAxisStatusBatch instead - a per-user flag would tell a curator a
 * word is done merely because they personally contributed to it. */
export interface AxisDecided {
  entry: boolean;
  etymology: boolean;
  // Every participant is expected to record every word themselves, so
  // "someone already recorded this" would be actively misleading here: it
  // would show green/done for a word this user personally hasn't touched yet,
  // just because a different speaker got to it first.
  //
  // Deliberately NOT "...and it still matches the word" - see the block below.
  audio: boolean;
  /** This user HAS recorded, but at least one of those recordings no longer matches
   * golden_record, so publish will drop it until golden converges or they record again.
   *
   * Never true while `audio` is false: it qualifies a finished task, it does not describe
   * a missing one. */
  audioDiverges: boolean;
  /** Whether this user has contributed an example of the word in use. Per-user for the
   * same reason audio is: an example is one person's own contribution, and several
   * different examples are more material rather than a conflict, so "someone else gave
   * one" must not read as done. Excluded examples do not count. */
  example: boolean;
}

// ---------------------------------------------------------------------------
// Whether a recording will PUBLISH, which is not whether the task is DONE
// ---------------------------------------------------------------------------
// 0006 freezes each recording's own recorded_display_text/recorded_syllables so a recording's
// pronunciation is never silently reinterpreted. The publish scripts then admit a recording only
// while those still equal golden_record's current values, and exclude it otherwise.
//
// The axis used to ask a weaker question - "does this user have a row in utterances?" - so a word
// whose spelling or split changed after recording read as DONE in the app while every one of its
// recordings was being dropped from the game. Nobody was told, and the axis that would have told
// them said green. Making `audio` require the match fixed the silence and introduced a worse
// failure: it answered the PUBLISH question ("will this ship?") in the field that reports the TASK
// question ("has this person done the work?"), and those come apart constantly.
//
// They came apart hardest for the person the app is for. A volunteer's spelling correction is a
// contribution, not a decision, so it never reaches golden_record - only a curator's ruling does.
// The audio screen then shows them the OLD spelling and invites them to say it the way they just
// argued it should be said (see AudioRecording.tsx, and 0006, which exists to preserve exactly
// that divergence). They record; the recording saves; the axis stays red until a curator rules.
// The task was unfinishable, and the queue re-served it forever.
//
// So the comparison stays, and what it decides changed. It now answers only "will publish accept
// this", reported as `audioDiverges` alongside a truthful `audio`. Nobody is misled about what
// ships, and nobody is handed work they cannot complete.
//
// The rule itself now lives in shared/src/publicationReadiness.ts, imported below, because the
// three scripts that actually DROP a recording - publishToR2.mjs, exportGameContent.mjs,
// exportWiktionaryDrafts.mjs - can import it too. It used to be five hand-copied strings that
// merely had to stay identical; it is now one. Only this file differs in what it DOES about a
// mismatch: it reports it (audioDiverges) where they exclude.
const RECORDING_MATCHES_GOLDEN = recordingMatchesGoldenSql('u', 'g');

export { recordingMatchesGolden };

export async function loadAxisDecided(client: Queryable, wordId: string, userId: string): Promise<AxisDecided> {
  const [decisionRows, utteranceRows, contributionRows, exampleRows] = await Promise.all([
    client.query<{ axis: DecisionAxis }>('select axis from word_decisions where word_id = $1', [wordId]),
    // One query answering both halves. bool_and over no rows is null, which is how "never
    // recorded" is told apart from "recorded, and all of it still matches".
    //
    // bool_AND rather than bool_or - any stale take makes the word diverge - because a
    // submission writes takes 1 and 2 and publish reads BOTH: take 1 for the word clip,
    // take 2's syllable_observations for the syllable clips. bool_or would call a word
    // clean while half its audio is being dropped, and would contradict the per-recording
    // "no longer matches" badges on the same screen.
    client.query<{ all_match: boolean | null }>(
      `select bool_and(${RECORDING_MATCHES_GOLDEN}) as all_match from utterances u
         join speakers s on s.speaker_id = u.speaker_id
         join golden_record g on g.word_id = u.word_id
       where u.word_id = $1 and s.user_id = $2`,
      [wordId, userId],
    ),
    client.query<{ axis: DecisionAxis }>(
      `select axis from contributions
       where word_id = $1 and submitted_by = $2 and status = 'active' and axis in ('entry', 'etymology')`,
      [wordId, userId],
    ),
    // Per-user and live-only, exactly like audio above: an example is one person's
    // contribution, not a claim to adjudicate, so this axis is done for THEM once they
    // have given one - and undone again if a curator excludes it.
    client.query(
      'select 1 from word_examples where word_id = $1 and submitted_by = $2 and excluded_at is null limit 1',
      [wordId, userId],
    ),
  ]);
  const decided = new Set(decisionRows.rows.map((r) => r.axis));
  const mine = new Set(contributionRows.rows.map((r) => r.axis));
  const allMatch = utteranceRows.rows[0]?.all_match ?? null;
  return {
    entry: decided.has('entry') || mine.has('entry'),
    etymology: decided.has('etymology') || mine.has('etymology'),
    audio: allMatch !== null,
    audioDiverges: allMatch === false,
    example: (exampleRows.rowCount ?? 0) > 0,
  };
}

/** Batched version of loadAxisDecided - for callers listing many words at
 * once (listMyAssignments.ts), which each need every word's own status but
 * shouldn't run one query set per word. Same semantics as loadAxisDecided,
 * computed for a whole word_id set in four queries total instead of 4*N. */
export async function loadAxisDecidedBatch(
  client: Queryable,
  wordIds: string[],
  userId: string,
): Promise<Map<string, AxisDecided>> {
  const [decisionRows, utteranceRows, contributionRows, exampleRows] = await Promise.all([
    client.query<{ word_id: string; axis: DecisionAxis }>('select word_id, axis from word_decisions where word_id = any($1)', [
      wordIds,
    ]),
    // Grouped counterpart of loadAxisDecided's aggregate - a word_id present here has been
    // recorded by this user; its all_match says whether publish will take all of it.
    client.query<{ word_id: string; all_match: boolean | null }>(
      `select u.word_id, bool_and(${RECORDING_MATCHES_GOLDEN}) as all_match from utterances u
         join speakers s on s.speaker_id = u.speaker_id
         join golden_record g on g.word_id = u.word_id
       where s.user_id = $1 and u.word_id = any($2)
       group by u.word_id`,
      [userId, wordIds],
    ),
    client.query<{ word_id: string; axis: DecisionAxis }>(
      `select distinct word_id, axis from contributions
       where submitted_by = $1 and word_id = any($2) and status = 'active' and axis in ('entry', 'etymology')`,
      [userId, wordIds],
    ),
    client.query<{ word_id: string }>(
      `select distinct word_id from word_examples
       where submitted_by = $1 and word_id = any($2) and excluded_at is null`,
      [userId, wordIds],
    ),
  ]);
  const decidedByWord = new Map<string, Set<string>>();
  for (const row of decisionRows.rows) {
    const existing = decidedByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else decidedByWord.set(row.word_id, new Set([row.axis]));
  }
  const mineByWord = new Map<string, Set<string>>();
  for (const row of contributionRows.rows) {
    const existing = mineByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else mineByWord.set(row.word_id, new Set([row.axis]));
  }
  const audioMatchByWord = new Map(utteranceRows.rows.map((r) => [r.word_id, r.all_match]));
  const wordsWithMyExample = new Set(exampleRows.rows.map((r) => r.word_id));

  const result = new Map<string, AxisDecided>();
  for (const wordId of wordIds) {
    const decided = decidedByWord.get(wordId) ?? new Set<string>();
    const mine = mineByWord.get(wordId) ?? new Set<string>();
    result.set(wordId, {
      entry: decided.has('entry') || mine.has('entry'),
      etymology: decided.has('etymology') || mine.has('etymology'),
      audio: audioMatchByWord.has(wordId),
      audioDiverges: audioMatchByWord.get(wordId) === false,
      example: wordsWithMyExample.has(wordId),
    });
  }
  return result;
}

/** How settled an axis is, globally - independent of who is asking.
 *
 * This is what a curator browsing the vocabulary wants. AxisDecided cannot
 * answer it: that flag goes true as soon as the ASKER has contributed, so a
 * curator who happened to weigh in on a word would see it as done while it
 * still has one unratified opinion. */
export type GlobalAxisState = 'golden' | 'provisional' | 'none';

export interface GlobalAxisStatus {
  entry: GlobalAxisState;
  etymology: GlobalAxisState;
  /** How many distinct speakers have recorded this word IN A FORM PUBLISH WILL TAKE -
   * audio has no decision step, so "settled" doesn't apply; coverage does. */
  speakerCount: number;
  /** Speakers whose recordings exist but no longer match the word, so they are excluded
   * from the number above. Reported separately rather than folded in: a curator asking
   * about coverage is asking what ships, and a shortfall they cannot see is the silence
   * this whole area was fixed for once already. */
  divergedSpeakerCount: number;
}

export async function loadGlobalAxisStatusBatch(
  client: Queryable,
  wordIds: string[],
): Promise<Map<string, GlobalAxisStatus>> {
  const [decisionRows, contributionRows, speakerRows] = await Promise.all([
    client.query<{ word_id: string; axis: DecisionAxis }>('select word_id, axis from word_decisions where word_id = any($1)', [
      wordIds,
    ]),
    client.query<{ word_id: string; axis: DecisionAxis }>(
      `select distinct word_id, axis from contributions
       where word_id = any($1) and status = 'active' and axis in ('entry', 'etymology')`,
      [wordIds],
    ),
    // Strict, unlike AxisDecided.audio, and the asymmetry is deliberate: this is a coverage
    // number read against what actually ships, so it must agree with the publish scripts.
    // AxisDecided.audio answers a different question - has this person done the task - and
    // reports the mismatch as audioDiverges instead of hiding the recording. Do not
    // "reconcile" the two; they were one question once, and that is what made a word
    // unfinishable for the volunteer who corrected its spelling.
    client.query<{ word_id: string; speakers: string; diverged_speakers: string }>(
      `select u.word_id,
              count(distinct u.speaker_id) filter (where ${RECORDING_MATCHES_GOLDEN}) as speakers,
              count(distinct u.speaker_id) filter (where not (${RECORDING_MATCHES_GOLDEN})) as diverged_speakers
       from utterances u join golden_record g on g.word_id = u.word_id
       where u.word_id = any($1) group by u.word_id`,
      [wordIds],
    ),
  ]);

  const goldenByWord = new Map<string, Set<string>>();
  for (const row of decisionRows.rows) {
    const existing = goldenByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else goldenByWord.set(row.word_id, new Set([row.axis]));
  }
  const provisionalByWord = new Map<string, Set<string>>();
  for (const row of contributionRows.rows) {
    const existing = provisionalByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else provisionalByWord.set(row.word_id, new Set([row.axis]));
  }
  const speakersByWord = new Map(speakerRows.rows.map((r) => [r.word_id, Number(r.speakers)]));
  const divergedSpeakersByWord = new Map(speakerRows.rows.map((r) => [r.word_id, Number(r.diverged_speakers)]));

  const state = (wordId: string, axis: DecisionAxis): GlobalAxisState => {
    if (goldenByWord.get(wordId)?.has(axis)) return 'golden';
    if (provisionalByWord.get(wordId)?.has(axis)) return 'provisional';
    return 'none';
  };

  const result = new Map<string, GlobalAxisStatus>();
  for (const wordId of wordIds) {
    result.set(wordId, {
      entry: state(wordId, 'entry'),
      etymology: state(wordId, 'etymology'),
      speakerCount: speakersByWord.get(wordId) ?? 0,
      divergedSpeakerCount: divergedSpeakersByWord.get(wordId) ?? 0,
    });
  }
  return result;
}

export type AxisReviewStatus = 'not_started' | 'in_review' | 'passed';

export interface ReviewStatus {
  entry: AxisReviewStatus;
  etymology: AxisReviewStatus;
}

/** Per-axis passed/in_review/not_started for a set of words, scoped to one
 * user's own pending contributions - same "2 queries total, not N+1" shape
 * as loadAxisDecidedBatch, for the admin assignment view (listUserAssignments.ts).
 * 'passed' mirrors word_decisions (global, same as AxisDecided); 'in_review'
 * is this user's own pending contribution on that axis - contributions has
 * no FK to assignments, so this is scoped by submitted_by, not by
 * assignment row (the best available signal given the current schema). */
export async function loadReviewStatusBatch(
  client: Queryable,
  wordIds: string[],
  userId: string,
): Promise<Map<string, ReviewStatus>> {
  const [decisionRows, pendingRows] = await Promise.all([
    client.query<{ word_id: string; axis: DecisionAxis }>('select word_id, axis from word_decisions where word_id = any($1)', [
      wordIds,
    ]),
    // contributions still carries pre-merge 'spelling'/'definition' rows as
    // history (0011 excluded the pending ones but left the reviewed ones
    // readable), so this filter names the live axes explicitly rather than
    // taking whatever the table happens to hold.
    client.query<{ word_id: string; axis: DecisionAxis }>(
      `select word_id, axis from contributions
       where status = 'active' and submitted_by = $1 and word_id = any($2)
         and axis in ('entry', 'etymology')`,
      [userId, wordIds],
    ),
  ]);
  const passedByWord = new Map<string, Set<string>>();
  for (const row of decisionRows.rows) {
    const existing = passedByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else passedByWord.set(row.word_id, new Set([row.axis]));
  }
  const pendingByWord = new Map<string, Set<string>>();
  for (const row of pendingRows.rows) {
    const existing = pendingByWord.get(row.word_id);
    if (existing) existing.add(row.axis);
    else pendingByWord.set(row.word_id, new Set([row.axis]));
  }

  const axes = ['entry', 'etymology'] as const;
  const result = new Map<string, ReviewStatus>();
  for (const wordId of wordIds) {
    const passed = passedByWord.get(wordId) ?? new Set<string>();
    const pending = pendingByWord.get(wordId) ?? new Set<string>();
    const entry = {} as ReviewStatus;
    for (const axis of axes) {
      entry[axis] = passed.has(axis) ? 'passed' : pending.has(axis) ? 'in_review' : 'not_started';
    }
    result.set(wordId, entry);
  }
  return result;
}

export async function loadDefinition(client: Queryable, wordId: string): Promise<string | null> {
  const result = await client.query<{ definition: string | null }>(
    'select definition from golden_record where word_id = $1',
    [wordId],
  );
  return result.rows[0]?.definition ?? null;
}

/** This word's own existing decision on one axis, in the same field
 * vocabulary diagnoseEntry/checkDefinition expect as a DiagnoseOverride -
 * word_decisions.decision is deliberately kept in that exact vocabulary
 * (see db/migrations/0001_initial_schema.sql's comment on that column), so
 * an already-decided word's review screen reflects its own decision
 * rather than re-proposing as if nothing had been decided yet. */
export async function loadAxisOverride(client: Queryable, wordId: string, axis: DecisionAxis): Promise<DiagnoseOverride | null> {
  const result = await client.query<{ decision: DiagnoseOverride; note: string | null }>(
    'select decision, note from word_decisions where word_id = $1 and axis = $2',
    [wordId, axis],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row.decision, ...(row.note ? { note: row.note } : {}) };
}

/** Every word's entry-axis decision at once, keyed by word_id - unlike
 * loadAxisOverride (one word at a time), this is for callers that need to
 * run diagnoseEntry across the WHOLE vocab (e.g. checkDuplicates.ts's
 * duplicate scan, which needs each existing word's own resolved
 * canonicalForm/matchedAltOfTargets to compare a new candidate against). */
export async function loadAllEntryOverrides(client: Queryable): Promise<DiagnosticsOverrides> {
  const rows = await client.query<{ word_id: string; decision: DiagnoseOverride; note: string | null }>(
    "select word_id, decision, note from word_decisions where axis = 'entry'",
  );
  const overrides: DiagnosticsOverrides = {};
  for (const row of rows.rows) {
    overrides[row.word_id] = { ...row.decision, ...(row.note ? { note: row.note } : {}) };
  }
  return overrides;
}
