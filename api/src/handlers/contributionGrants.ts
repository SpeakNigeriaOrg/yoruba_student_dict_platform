// handlers/contributionGrants.ts
//
// The one-time question a contributor answers after logging in (0019), and reading
// back whether they still need to be asked.
//
// ---------------------------------------------------------------------------
// Why acceptance names BOTH subjects
// ---------------------------------------------------------------------------
// A grant can be keyed on the account or on the voice, and an in-app acceptance
// records both, because the person accepting is both. Doing only one of them would
// leave a real gap in each direction:
//
//   user only     the audio lookup goes speaker -> speakers.user_id -> grant, so it
//                 depends on that link still being right. db/README.md documents the
//                 statement for re-pointing a speaker at a different account after an
//                 identity change - a link that has already been repaired by hand once
//                 is not one to hang someone's consent on.
//   speaker only  written contributions are keyed by users.user_id (word_examples
//                 .submitted_by), and the export publishes their text. A speaker-keyed
//                 grant says nothing about those.
//
// So the speaker row is created here if it does not exist yet, via the same
// getOrCreateSpeakerForUser the recording flow uses. Accepting is the moment someone
// becomes a contributor; waiting for their first upload to mint the row would mean the
// grant they just gave has nothing to attach to.
//
// ---------------------------------------------------------------------------
// Declining is a real answer, and it is recorded as one
// ---------------------------------------------------------------------------
// Not a silent skip, and not an absence. 0019's three states only work if "we asked
// and they said no" is distinguishable from "nobody has asked" - the first is settled
// and the second is outstanding work. It writes a no_grant_reason row, which reads as
// 'declined' through both rights views.
//
// Nothing about declining restricts what someone can then do in the app. Consent
// obtained by withholding a paid contributor's work is not consent, and the material
// stays usable internally either way - that is what the engagement was for.

import type { Queryable } from '../db.js';
import { blocksContribution, CONTRIBUTOR_TERMS_VERSION, needsContributorTerms } from '@yoruba-student-dict-platform/shared';
import { getOrCreateSpeakerForUser } from '../speakers.js';

export interface GrantStatus {
  /** unknown | declined | revoked | internal_only | open_permitted - 0019's single
   * label, computed by grant_release_state and never re-derived here. */
  releaseState: string;
  /** Which version of the wording they answered, or null if they never have. */
  acceptedVersion: string | null;
  /** The version the app would show them now. */
  currentVersion: string;
  /** Whether to interrupt them with it. */
  needsAcceptance: boolean;
  /** Whether this account may write at all.
   *
   * Reported rather than left for the app to derive from releaseState, so the client and
   * the server cannot disagree about who is blocked - the app uses it to put the agreement
   * back in front of someone instead of letting them record for ten minutes and lose it to
   * a 403 on save. */
  canContribute: boolean;
}

export async function getGrantStatus(client: Queryable, userId: string): Promise<GrantStatus> {
  const { rows } = await client.query<{ release_state: string; instrument_ref: string | null }>(
    'select release_state, instrument_ref from contributor_release_rights where user_id = $1',
    [userId],
  );
  const row = rows[0];
  // No row at all means the account exists but the view found no user - impossible for
  // a resolved user, since the view is a left join FROM users. Treated as unknown
  // rather than thrown, because a login that 500s over a consent lookup is a worse
  // failure than one that asks the question again.
  const acceptedVersion = row?.instrument_ref ?? null;
  const releaseState = row?.release_state ?? 'unknown';
  return {
    releaseState,
    acceptedVersion,
    currentVersion: CONTRIBUTOR_TERMS_VERSION,
    canContribute: !blocksContribution(releaseState),
    // A revoked or declined grant still ANSWERS the current version, so it must not
    // re-prompt: asking someone who said no to say it again every time they log in is
    // nagging, and it is also how a no becomes a yes by attrition.
    needsAcceptance: needsContributorTerms(acceptedVersion),
  };
}

export interface RecordGrantInput {
  /** Refused when it is not the version this build serves, rather than stored as given.
   * The client sends back what it displayed, and a mismatch means they answered a
   * different page from the one now current - which is exactly what the version exists
   * to catch, so accepting it would defeat the mechanism. */
  termsVersion: string;
  /** The open-release half is the one someone can answer separately (the terms say so),
   * so it comes off the wire. Everything else about an acceptance is fixed by the
   * wording they just read, and is therefore set here rather than trusted from a
   * client that could claim any permission it liked. */
  openReleasePermitted?: boolean;
  attributionMode?: 'real_name' | 'pseudonym' | 'anonymous';
  attributionName?: string | null;
  /** Present means declined. The reason is free text so someone can say why, but a
   * blank one is still a valid answer - the fact of declining is the record. */
  declineReason?: string;
}

export class TermsVersionMismatchError extends Error {
  constructor(sent: string, current: string) {
    super(`these terms are version '${current}', not '${sent}' - reload and read the current wording`);
    this.name = 'TermsVersionMismatchError';
  }
}

/** Writes the answer. Always a new row, never an update: a grant is a statement made on
 * a date, and 0019's views take the most recent one, so changing your mind is another
 * statement rather than an edit to the last. That is also what keeps the history of
 * what someone agreed to, which is the whole point of recording an instrument. */
export async function recordContributorGrant(
  client: Queryable,
  userId: string,
  displayName: string,
  input: RecordGrantInput,
): Promise<GrantStatus> {
  if (input.termsVersion !== CONTRIBUTOR_TERMS_VERSION) {
    throw new TermsVersionMismatchError(input.termsVersion, CONTRIBUTOR_TERMS_VERSION);
  }

  const speakerId = await getOrCreateSpeakerForUser(client, userId, displayName);

  if (input.declineReason !== undefined) {
    await client.query(
      `insert into contribution_grants (user_id, speaker_id, instrument, instrument_ref, no_grant_reason, recorded_by)
       values ($1, $2, 'in_app_acceptance', $3, $4, $1)`,
      [userId, speakerId, CONTRIBUTOR_TERMS_VERSION, input.declineReason.trim() || 'declined at the login prompt'],
    );
    return getGrantStatus(client, userId);
  }

  await client.query(
    `insert into contribution_grants
       (user_id, speaker_id, instrument, instrument_ref, stated_on, rights_basis,
        internal_use_permitted, open_release_permitted, attribution_required, recorded_by)
     values ($1, $2, 'in_app_acceptance', $3, current_date, 'assigned', true, $4, $5, $1)`,
    [
      userId,
      speakerId,
      CONTRIBUTOR_TERMS_VERSION,
      input.openReleasePermitted ?? false,
      // Attribution is required unless they asked to be anonymous. Derived from the
      // choice rather than sent as its own flag, so the credit line and the preference
      // cannot disagree about whether anyone needs crediting.
      input.attributionMode !== 'anonymous',
    ],
  );

  if (input.attributionMode) {
    await client.query('update speakers set attribution_mode = $1, attribution_name = $2 where speaker_id = $3', [
      input.attributionMode,
      input.attributionMode === 'anonymous' ? null : (input.attributionName?.trim() || displayName),
      speakerId,
    ]);
  }

  return getGrantStatus(client, userId);
}
