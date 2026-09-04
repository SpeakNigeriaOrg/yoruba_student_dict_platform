// handlers/userContribution.ts
//
// One person's work on one word, read-only.
//
// ---------------------------------------------------------------------------
// The user page's links went to the wrong screen
// ---------------------------------------------------------------------------
// AdminUserDetail lists what someone has recently contributed, and every row was a link
// into the REVIEW screens - the place where you record your own opinion of a word. A
// curator following "Ada · entry · 3 days ago" arrived at a form asking them what THEY
// thought the entry should be. The one thing the row promised - what Ada said - was
// nowhere on the screen it led to.
//
// wordDossier.ts answers the neighbouring question (everything anyone holds about a word)
// and is the right screen for adjudicating. It is the wrong screen for this one, because
// it is keyed on the word: it cannot show a 'new_entry' proposal at all (those have a null
// word_id by construction), and on a word with six contributors it buries the one person
// you asked about among the other five.
//
// So this is keyed on the CONTRIBUTION, and carries with it the rest of what that same
// person did to that same word - their other axes, their examples, their recordings. Four
// axes live in three different tables (contributions, word_examples, utterances via
// speakers), and none of them reference each other; the person and the word are the only
// things they have in common, which is exactly what this join is.
//
// ---------------------------------------------------------------------------
// Nothing is filtered out
// ---------------------------------------------------------------------------
// Superseded and excluded rows are included, in every table that has them. This is the
// screen for reading someone's record, and "their last three submissions were excluded as
// spam" is precisely the thing a filtered view would hide. Both 0013 (contributions) and
// 0015 (word_examples) kept those rows deliberately; every other query in the app drops
// them.
//
// Rights travel with the content. An example or a recording shown here may be under an
// unknown or a withdrawn grant, and a curator reading it must not be able to mistake it
// for something publishable - so both release states are on the payload rather than
// available one screen away.

import type { Queryable } from '../db.js';
import { recordingMatchesGolden } from '../reviewShared.js';
import { UserNotFoundError } from './errors.js';
import type { ReleaseState } from './userDossier.js';

export class ContributionNotFoundError extends Error {
  constructor(public readonly contributionId: string) {
    super(`contribution '${contributionId}' not found`);
    this.name = 'ContributionNotFoundError';
  }
}

/** One contribution as evidence: what they claimed, and whether it is what the record now
 * says.
 *
 * `resolvedValue` is the claim (0013's frozen outcome) and `proposedValue` is the action
 * that produced it. Both are carried: the resolved outcome is what a reader should compare
 * against other claims, but rows submitted before 0013 have none, and a 'new_entry'
 * proposal never had one - its proposed_value mirrors vocab.json's entry shape instead. */
export interface UserContributionClaim {
  contributionId: string;
  axis: string;
  status: string;
  proposedValue: unknown;
  resolvedValue: unknown;
  valueFingerprint: string | null;
  note: string | null;
  submittedAt: string;
  excludedReason: string | null;
  excludedAt: string | null;
  /** Whether this claim is what the golden record holds for its axis right now.
   *
   * Null rather than false when it cannot be told: an undecided axis, or a contribution
   * with no fingerprint. Comparing fingerprints rather than values keeps this consistent
   * with how consensus decides two people agree - see shared/src/consensus.ts. */
  agreesWithRecord: boolean | null;
}

export interface UserContributionExample {
  exampleId: string;
  exampleType: string;
  exampleText: string;
  translation: string;
  audioDataBase64: string;
  submittedAt: string;
  recordedWordText: string;
  /** Recorded under a spelling the word no longer has. */
  wordTextChanged: boolean;
  excludedReason: string | null;
  excludedAt: string | null;
}

export interface UserContributionRecording {
  utteranceId: string;
  speakerId: string;
  speakerName: string;
  takeNumber: number;
  status: string;
  recordedDisplayText: string;
  recordedSyllables: string[];
  /** False when the publish step would silently drop this take: it was recorded under a
   * spelling or a syllable split the word no longer has. */
  matchesGolden: boolean;
  durationS: number | null;
  recordedAt: string;
  segmentCount: number;
  releaseState: ReleaseState;
  /** Null for a take whose delivery copy has not been produced - see 0022. */
  audioDataBase64: string | null;
  deliveryMediaType: string | null;
}

export interface UserContributionWord {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  entryType: 'phrase' | null;
  pos: string | null;
  englishGloss: string | null;
  citedEntryId: string | null;
  components: Array<{ wordId: string; displayText: string; position: number }>;
}

export interface UserContributionDetail {
  userId: string;
  email: string;
  displayName: string | null;
  /** This account's grant over its WRITTEN work (examples, translations). A recording's
   * own state lives on the recording - a voice and an account are granted separately. */
  releaseState: ReleaseState;
  contribution: UserContributionClaim;
  /** The same person's other contributions to the same word, newest first. Empty for a
   * 'new_entry' proposal, which has no word to share. */
  alsoOnThisWord: UserContributionClaim[];
  /** Null for a 'new_entry' proposal, and also for a word deleted since - the claim is
   * still readable either way, which is the point of keeping it. */
  word: UserContributionWord | null;
  examples: UserContributionExample[];
  recordings: UserContributionRecording[];
}

export async function loadUserContribution(
  client: Queryable,
  userId: string,
  contributionId: string,
): Promise<UserContributionDetail> {
  const user = await client.query<{ email: string; display_name: string | null; release_state: ReleaseState | null }>(
    // Through the rights VIEW, never contribution_grants - 0019 is explicit that the
    // most-recent-statement-wins rule has exactly one home.
    `select u.email, u.display_name, r.release_state
       from users u
       left join contributor_release_rights r on r.user_id = u.user_id
      where u.user_id = $1`,
    [userId],
  );
  if (user.rowCount === 0) throw new UserNotFoundError(userId);
  const identity = user.rows[0];

  // Scoped to the user in the WHERE clause, so a contribution belonging to somebody else
  // reads as absent rather than as somebody else's - a curator following a link from Ada's
  // page must never be shown Ben's claim under Ada's name.
  const claim = await client.query<ClaimRow>(
    `${CLAIM_COLUMNS}
      where c.contribution_id = $1 and c.submitted_by = $2`,
    [contributionId, userId],
  );
  if (claim.rowCount === 0) throw new ContributionNotFoundError(contributionId);
  const c = claim.rows[0];
  const wordId = c.word_id;

  if (wordId === null) {
    return {
      userId,
      email: identity.email,
      displayName: identity.display_name,
      releaseState: identity.release_state ?? 'unknown',
      contribution: toClaim(c),
      alsoOnThisWord: [],
      word: null,
      examples: [],
      recordings: [],
    };
  }

  const [word, components, siblings, examples, recordings] = await Promise.all([
    client.query<{
      display_text: string;
      syllables: string[];
      definition: string | null;
      entry_type: 'phrase' | null;
      pos: string | null;
      english_gloss: string | null;
      cited_entry_id: string | null;
    }>(
      // left join: a word created before 0014 has no citation row and is still a word.
      `select g.display_text, g.syllables, g.definition, g.entry_type, g.pos, g.english_gloss,
              uc.entry_id as cited_entry_id
         from golden_record g
         left join upstream_citations uc on uc.word_id = g.word_id
        where g.word_id = $1`,
      [wordId],
    ),
    client.query<{ component_word_id: string; display_text: string; component_position: number }>(
      `select c.component_word_id, g.display_text, c.component_position
         from golden_record_components c join golden_record g on g.word_id = c.component_word_id
        where c.word_id = $1 order by c.component_position`,
      [wordId],
    ),
    client.query<ClaimRow>(
      `${CLAIM_COLUMNS}
        where c.word_id = $1 and c.submitted_by = $2 and c.contribution_id <> $3
        order by c.submitted_at desc`,
      [wordId, userId, contributionId],
    ),
    // At most one row: 0015 allows one example per person per word and the submit handler
    // upserts on that key. Kept as a list anyway, so a later relaxation of that constraint
    // does not need a payload change. Excluded rows included, unlike listExamples - see
    // the file header.
    client.query<{
      example_id: string;
      example_type: string;
      example_text: string;
      translation: string;
      audio_base64: string;
      submitted_at: Date;
      recorded_word_text: string;
      word_text_changed: boolean;
      excluded_reason: string | null;
      excluded_at: string | null;
    }>(
      `select e.example_id, e.example_type, e.example_text, e.translation,
              encode(e.audio_data, 'base64') as audio_base64, e.submitted_at, e.recorded_word_text,
              (e.recorded_word_text <> g.display_text) as word_text_changed,
              e.excluded_reason, e.excluded_at
         from word_examples e
         join golden_record g on g.word_id = e.word_id
        where e.word_id = $1 and e.submitted_by = $2
        order by e.submitted_at`,
      [wordId, userId],
    ),
    // A recording belongs to a SPEAKER, and a speaker belongs to an account - there is no
    // user_id on utterances. This join is the only way to ask "what did this person
    // record", and it is why the word dossier cannot answer the question: it carries a
    // speaker name and no account at all.
    client.query<{
      utterance_id: string;
      speaker_id: string;
      speaker_name: string;
      take_number: number;
      status: string;
      recorded_display_text: string;
      recorded_syllables: string[];
      duration_s: string | null;
      recorded_at: string;
      segment_count: number;
      release_state: ReleaseState | null;
      audio_data: Buffer | null;
      delivery_media_type: string | null;
    }>(
      `select u.utterance_id, u.speaker_id, s.display_name as speaker_name, u.take_number, u.status,
              u.recorded_display_text, u.recorded_syllables, u.duration_s, u.recorded_at,
              (select count(*)::int from syllable_observations so where so.utterance_id = u.utterance_id)
                as segment_count,
              r.release_state, u.audio_data, u.delivery_media_type
         from utterances u
         join speakers s on s.speaker_id = u.speaker_id
         left join speaker_release_rights r on r.speaker_id = u.speaker_id
        where u.word_id = $1 and s.user_id = $2
        order by u.take_number`,
      [wordId, userId],
    ),
  ]);

  // The word may have been deleted since the contribution was made. The claim survives
  // that deliberately (contributions.word_id cascades, so in practice the row would be
  // gone too - but a null here must render rather than throw).
  const w = word.rows[0] ?? null;
  const golden = w ? { display_text: w.display_text, syllables: w.syllables } : null;

  const decisions = await client.query<{ axis: string; value_fingerprint: string | null }>(
    'select axis, value_fingerprint from word_decisions where word_id = $1',
    [wordId],
  );
  const recordFingerprints = new Map(decisions.rows.map((r) => [r.axis, r.value_fingerprint]));

  return {
    userId,
    email: identity.email,
    displayName: identity.display_name,
    releaseState: identity.release_state ?? 'unknown',
    contribution: toClaim(c, recordFingerprints),
    alsoOnThisWord: siblings.rows.map((r) => toClaim(r, recordFingerprints)),
    word: w && {
      wordId,
      displayText: w.display_text,
      syllables: w.syllables,
      definition: w.definition,
      entryType: w.entry_type,
      pos: w.pos,
      englishGloss: w.english_gloss,
      citedEntryId: w.cited_entry_id,
      components: components.rows.map((r) => ({
        wordId: r.component_word_id,
        displayText: r.display_text,
        position: r.component_position,
      })),
    },
    examples: examples.rows.map((r) => ({
      exampleId: r.example_id,
      exampleType: r.example_type,
      exampleText: r.example_text,
      translation: r.translation,
      audioDataBase64: r.audio_base64,
      submittedAt: r.submitted_at.toISOString(),
      recordedWordText: r.recorded_word_text,
      wordTextChanged: r.word_text_changed,
      excludedReason: r.excluded_reason,
      excludedAt: r.excluded_at,
    })),
    recordings: recordings.rows.map((r) => ({
      utteranceId: r.utterance_id,
      speakerId: r.speaker_id,
      speakerName: r.speaker_name,
      takeNumber: r.take_number,
      status: r.status,
      recordedDisplayText: r.recorded_display_text,
      recordedSyllables: r.recorded_syllables,
      // Delegated rather than compared here, so this badge and what the publish step
      // actually drops cannot drift apart.
      matchesGolden: golden ? recordingMatchesGolden(r.recorded_display_text, r.recorded_syllables, golden) : false,
      durationS: r.duration_s === null ? null : Number(r.duration_s),
      recordedAt: r.recorded_at,
      segmentCount: r.segment_count,
      releaseState: r.release_state ?? 'unknown',
      audioDataBase64: r.audio_data === null ? null : r.audio_data.toString('base64'),
      deliveryMediaType: r.delivery_media_type,
    })),
  };
}

interface ClaimRow {
  contribution_id: string;
  word_id: string | null;
  axis: string;
  status: string;
  proposed_value: unknown;
  resolved_value: unknown;
  value_fingerprint: string | null;
  note: string | null;
  submitted_at: string;
  excluded_reason: string | null;
  excluded_at: string | null;
}

/** Shared by the two claim queries - the clicked contribution and its siblings - so the
 * two cannot select different columns for the same shape. */
const CLAIM_COLUMNS = `select c.contribution_id, c.word_id, c.axis, c.status, c.proposed_value, c.resolved_value,
            c.value_fingerprint, c.note, c.submitted_at, c.excluded_reason, c.excluded_at
       from contributions c`;

function toClaim(r: ClaimRow, recordFingerprints?: Map<string, string | null>): UserContributionClaim {
  const decided = recordFingerprints?.get(r.axis);
  return {
    contributionId: r.contribution_id,
    axis: r.axis,
    status: r.status,
    proposedValue: r.proposed_value,
    resolvedValue: r.resolved_value,
    valueFingerprint: r.value_fingerprint,
    note: r.note,
    submittedAt: r.submitted_at,
    excludedReason: r.excluded_reason,
    excludedAt: r.excluded_at,
    agreesWithRecord: !r.value_fingerprint || decided == null ? null : decided === r.value_fingerprint,
  };
}
