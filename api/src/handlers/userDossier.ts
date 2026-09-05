// handlers/userDossier.ts
//
// Everything the system holds about one person, on one page.
//
// ---------------------------------------------------------------------------
// The account had no screen
// ---------------------------------------------------------------------------
// #/users/{id} rendered a word-assignment manager and nothing else. It never said whose
// page it was - not the email, not the display name, not the role, not when they joined.
// A curator clicking a name in the list arrived somewhere that had forgotten the name.
//
// That is worse than an empty section, because the list they came from shows MORE than the
// detail view does: email or display name, role, the three assignment counts, and the
// promote/demote control. Following the link lost information.
//
// The email in particular is the account's identity. It is what Google authenticates, what
// GetRoles matches on to decide whether someone is a curator, and the only durable handle
// on a person - display_name is nullable and duplicable. A screen about a user that cannot
// show their email cannot answer "is this the right account?", which is the question a
// curator opens it to ask.
//
// ---------------------------------------------------------------------------
// Reads through the rights VIEW, never the grants table
// ---------------------------------------------------------------------------
// 0019 is explicit that contributor_release_rights is the only place the
// most-recent-statement-wins rule lives, and that a statement's date (stated_on) rather
// than a grant date is the ordering key so a withdrawal can supersede an acceptance.
// Querying contribution_grants here would be a second copy of that precedence rule.
//
// Mirrors wordDossier.ts: a join arranged by the thing the rows are all about, not a table
// browser.

import type { Queryable } from '../db.js';
import type { AppRole } from '../auth.js';
import { UserNotFoundError } from './errors.js';

export type ReleaseState = 'agreed' | 'declined' | 'revoked' | 'unknown';

/** Whether this person's work may be published, and on what basis.
 *
 * `agreedVersion` is carried next to the state on purpose: consent to v1 is not consent to
 * v2, and 0019 built instrument_ref precisely so a later re-ask is honest. A curator seeing
 * 'agreed' against a superseded version is looking at someone who needs asking again, and
 * without the version that is indistinguishable from someone who is fully covered. */
export interface UserRights {
  releaseState: ReleaseState;
  instrument: string | null;
  /** Which wording they agreed to - a terms version, or a pointer at a contract. */
  agreedVersion: string | null;
  statedOn: string | null;
  noGrantReason: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  /** The wording in force now, so a stale agreement is visible as stale. */
  currentTermsVersion: string;
  /** True when they hold a live agreement against the CURRENT wording. */
  coversCurrentTerms: boolean;
}

/** A voice belonging to this account. Usually zero or one; the schema allows more, and a
 * speaker may exist with no account at all (which is why this is a list rather than a
 * field on the user). */
export interface UserSpeaker {
  speakerId: string;
  displayName: string;
  dialectRegion: string | null;
  utteranceCount: number;
}

/** What this person has actually done, by axis and by outcome.
 *
 * Split by status rather than totalled, because the three mean different things: `active`
 * is what they currently assert, `superseded` is a belief they revised (0013 keeps it
 * deliberately - a change of mind is evidence), and `excluded` is a vote a curator removed
 * from the tally. One number would hide the distinction that matters most, which is whether
 * a contributor's work is being thrown out. */
export interface UserContributionCounts {
  axis: string;
  active: number;
  superseded: number;
  excluded: number;
  applied: number;
}

/** One recent contribution, so "what has this person been working on" is answerable. */
export interface UserRecentContribution {
  contributionId: string;
  wordId: string | null;
  displayText: string | null;
  axis: string;
  status: string;
  submittedAt: string;
}

export interface UserDossier {
  userId: string;
  email: string;
  displayName: string | null;
  role: AppRole;
  createdAt: string;

  rights: UserRights;
  speakers: UserSpeaker[];

  contributions: UserContributionCounts[];
  /** Written examples they authored that have not been excluded. */
  exampleCount: number;
  /** Recordings made under an account of theirs. */
  utteranceCount: number;
  imageCount: number;
  /** Words whose golden_record row they last wrote - authoring or applying a decision. */
  wordsTouched: number;
  /** Records they SET, which only a curator can do. Zero for every volunteer. */
  decisionsMade: number;
  assignedWordCount: number;

  recentContributions: UserRecentContribution[];
}

/** How many recent contributions to carry. Enough to see what someone has been doing
 * without turning the dossier into a paginated log - the full history of one word is the
 * word's own dossier, which is where a curator goes next. */
const RECENT_LIMIT = 20;

export async function loadUserDossier(
  client: Queryable,
  userId: string,
  currentTermsVersion: string,
): Promise<UserDossier> {
  // Identity first and on its own, so a missing user is a clean 404 rather than a page of
  // zeroed counts about nobody.
  const user = await client.query<{
    email: string;
    display_name: string | null;
    role: AppRole;
    created_at: string;
  }>('select email, display_name, role, created_at from users where user_id = $1', [userId]);

  if (user.rowCount === 0) throw new UserNotFoundError(userId);
  const identity = user.rows[0];

  const [rights, speakers, axisTallies, totals, recent] = await Promise.all([
    client.query<{
      release_state: ReleaseState;
      instrument: string | null;
      instrument_ref: string | null;
      stated_on: string | null;
      no_grant_reason: string | null;
      revoked_at: string | null;
      revoked_reason: string | null;
    }>(
      `select release_state, instrument, instrument_ref, stated_on,
              no_grant_reason, revoked_at, revoked_reason
         from contributor_release_rights where user_id = $1`,
      [userId],
    ),
    client.query<{ speaker_id: string; display_name: string; dialect_region: string | null; utterance_count: number }>(
      `select s.speaker_id, s.display_name, s.dialect_region,
              (select count(*)::int from utterances u where u.speaker_id = s.speaker_id) as utterance_count
         from speakers s where s.user_id = $1
        order by s.display_name`,
      [userId],
    ),
    // One row per (axis, status) rather than one query per axis - the axes are open-ended
    // (0011 left 'spelling'/'definition' rows behind as history) and hard-coding them here
    // would silently drop a contributor's pre-merge work from their own page.
    client.query<{ axis: string; status: string; n: number }>(
      `select axis, status, count(*)::int as n
         from contributions where submitted_by = $1
        group by axis, status`,
      [userId],
    ),
    // The single-value counts, as one round trip. Each is a scalar subquery so a person with
    // nothing in a given table still gets a 0 rather than a missing row.
    client.query<{
      example_count: number;
      utterance_count: number;
      image_count: number;
      words_touched: number;
      decisions_made: number;
      assigned_word_count: number;
    }>(
      `select
         (select count(*)::int from word_examples e
           where e.submitted_by = $1 and e.excluded_at is null) as example_count,
         (select count(*)::int from utterances u
            join speakers s on s.speaker_id = u.speaker_id
           where s.user_id = $1) as utterance_count,
         (select count(*)::int from word_images i where i.uploaded_by = $1) as image_count,
         (select count(*)::int from golden_record g where g.updated_by = $1) as words_touched,
         (select count(*)::int from word_decisions d where d.decided_by = $1) as decisions_made,
         (select count(*)::int from assignments a where a.user_id = $1) as assigned_word_count`,
      [userId],
    ),
    // left join, not join: a 'new_entry' contribution has a null word_id by construction
    // (0001's contributions_new_entry_word_id_null), and an inner join would hide exactly
    // the contributions of someone whose main activity is proposing new words.
    client.query<{
      contribution_id: string;
      word_id: string | null;
      display_text: string | null;
      axis: string;
      status: string;
      submitted_at: string;
    }>(
      `select c.contribution_id, c.word_id, g.display_text, c.axis, c.status, c.submitted_at
         from contributions c
         left join golden_record g on g.word_id = c.word_id
        where c.submitted_by = $1
        order by c.submitted_at desc
        limit ${RECENT_LIMIT}`,
      [userId],
    ),
  ]);

  const byAxis = new Map<string, UserContributionCounts>();
  for (const row of axisTallies.rows) {
    const existing = byAxis.get(row.axis) ?? { axis: row.axis, active: 0, superseded: 0, excluded: 0, applied: 0 };
    if (row.status === 'active') existing.active = Number(row.n);
    else if (row.status === 'superseded') existing.superseded = Number(row.n);
    else if (row.status === 'excluded') existing.excluded = Number(row.n);
    else if (row.status === 'applied') existing.applied = Number(row.n);
    byAxis.set(row.axis, existing);
  }

  // A user with no row in the view is 'unknown', which is a real state and the commonest
  // one: nobody has asked them yet. The view left-joins so this should not happen for an
  // existing user, but the fallback keeps a missing row from reading as an agreement.
  const r = rights.rows[0];
  const releaseState: ReleaseState = r?.release_state ?? 'unknown';

  const counts = totals.rows[0];

  return {
    userId,
    email: identity.email,
    displayName: identity.display_name,
    role: identity.role,
    createdAt: identity.created_at,

    rights: {
      releaseState,
      instrument: r?.instrument ?? null,
      agreedVersion: r?.instrument_ref ?? null,
      statedOn: r?.stated_on ?? null,
      noGrantReason: r?.no_grant_reason ?? null,
      revokedAt: r?.revoked_at ?? null,
      revokedReason: r?.revoked_reason ?? null,
      currentTermsVersion,
      // Only an unrevoked agreement against THIS wording counts. 'agreed' against v1 while
      // v2 is in force is someone to ask again, not someone covered.
      coversCurrentTerms: releaseState === 'agreed' && r?.instrument_ref === currentTermsVersion,
    },

    speakers: speakers.rows.map((s) => ({
      speakerId: s.speaker_id,
      displayName: s.display_name,
      dialectRegion: s.dialect_region,
      utteranceCount: Number(s.utterance_count),
    })),

    contributions: [...byAxis.values()].sort((a, b) => a.axis.localeCompare(b.axis)),
    exampleCount: Number(counts.example_count),
    utteranceCount: Number(counts.utterance_count),
    imageCount: Number(counts.image_count),
    wordsTouched: Number(counts.words_touched),
    decisionsMade: Number(counts.decisions_made),
    assignedWordCount: Number(counts.assigned_word_count),

    recentContributions: recent.rows.map((c) => ({
      contributionId: c.contribution_id,
      wordId: c.word_id,
      displayText: c.display_text,
      axis: c.axis,
      status: c.status,
      submittedAt: c.submitted_at,
    })),
  };
}
