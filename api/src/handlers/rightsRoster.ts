// handlers/rightsRoster.ts
//
// Who has agreed to the contributor terms, who has refused, and who nobody has asked.
//
// 0019 built two views for exactly this and says so: "A speaker or user with nothing
// contributed yet still appears here. 'Who have we not asked' is a question about people,
// not about assets." They have only ever been queried one person at a time, through
// GET /api/grants/me, which can answer the question for the person asking it and nobody
// else. So the roster the views were designed to produce has never existed.
//
// The population this is for is not hypothetical. Three legacy speakers, created by the
// import scripts with no user_id, carry 189 recordings between them and sit at 'unknown'
// with no route to a grant row - the in-app prompt cannot reach a speaker with no account.
// db/README.md records that they need an out-of-band row naming the real instrument, and
// that writing an acceptance for them "would launder an assumption into a consent someone
// gave on a date". Nothing in the app has ever shown that they are outstanding.
//
// Read through the views, never the table: the most-recent-statement-wins rule lives there,
// and stated_on rather than granted_on is the ordering key precisely so a refusal - which
// grants nothing and so has no grant date - can supersede an earlier acceptance.

import type { Queryable } from '../db.js';

export type ReleaseState = 'agreed' | 'declined' | 'revoked' | 'unknown';

export interface SpeakerRights {
  speakerId: string;
  displayName: string;
  dialectRegion: string | null;
  releaseState: ReleaseState;
  instrument: string | null;
  instrumentRef: string | null;
  statedOn: string | null;
  /** Recordings this voice has contributed. What is actually at stake for this row. */
  utteranceCount: number;
  /** True when there is no account behind the voice, so the in-app prompt can never reach
   * them and only an out-of-band grant can resolve it. */
  hasAccount: boolean;
}

export interface ContributorRights {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  releaseState: ReleaseState;
  instrument: string | null;
  instrumentRef: string | null;
  statedOn: string | null;
  /** Written work that would be published under this person's grant. */
  exampleCount: number;
  contributionCount: number;
}

export interface RightsRoster {
  /** The wording currently in force. A grant against an older version is not consent to
   * this one, which is why acceptedVersion is worth showing next to the state. */
  currentTermsVersion: string;
  speakers: SpeakerRights[];
  contributors: ContributorRights[];
  counts: {
    speakers: Record<ReleaseState, number>;
    contributors: Record<ReleaseState, number>;
    /** Recordings whose speaker has not agreed - the number that would be withheld from an
     * external release today. */
    utterancesWithoutAgreement: number;
    /** Voices with no account, so unreachable by the in-app prompt. */
    speakersWithoutAccount: number;
  };
}

const zero = (): Record<ReleaseState, number> => ({ agreed: 0, declined: 0, revoked: 0, unknown: 0 });

export async function loadRightsRoster(client: Queryable, currentTermsVersion: string): Promise<RightsRoster> {
  const [speakerRows, contributorRows] = await Promise.all([
    client.query<{
      speaker_id: string;
      display_name: string;
      dialect_region: string | null;
      release_state: ReleaseState;
      instrument: string | null;
      instrument_ref: string | null;
      stated_on: string | null;
      utterance_count: number;
      has_account: boolean;
    }>(
      `select r.speaker_id, r.display_name, r.dialect_region, r.release_state,
              r.instrument, r.instrument_ref, r.stated_on,
              (select count(*)::int from utterances u where u.speaker_id = r.speaker_id) as utterance_count,
              (s.user_id is not null) as has_account
         from speaker_release_rights r
         join speakers s on s.speaker_id = r.speaker_id
        order by r.release_state, r.display_name`,
    ),
    client.query<{
      user_id: string;
      email: string;
      display_name: string | null;
      role: string;
      release_state: ReleaseState;
      instrument: string | null;
      instrument_ref: string | null;
      stated_on: string | null;
      example_count: number;
      contribution_count: number;
    }>(
      `select r.user_id, r.email, r.display_name, u.role, r.release_state,
              r.instrument, r.instrument_ref, r.stated_on,
              (select count(*)::int from word_examples e
                where e.submitted_by = r.user_id and e.excluded_at is null) as example_count,
              (select count(*)::int from contributions c
                where c.submitted_by = r.user_id and c.status = 'active') as contribution_count
         from contributor_release_rights r
         join users u on u.user_id = r.user_id
        order by r.release_state, r.email`,
    ),
  ]);

  const speakers = speakerRows.rows.map((r) => ({
    speakerId: r.speaker_id,
    displayName: r.display_name,
    dialectRegion: r.dialect_region,
    releaseState: r.release_state,
    instrument: r.instrument,
    instrumentRef: r.instrument_ref,
    statedOn: r.stated_on,
    utteranceCount: Number(r.utterance_count),
    hasAccount: r.has_account,
  }));
  const contributors = contributorRows.rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    releaseState: r.release_state,
    instrument: r.instrument,
    instrumentRef: r.instrument_ref,
    statedOn: r.stated_on,
    exampleCount: Number(r.example_count),
    contributionCount: Number(r.contribution_count),
  }));

  const counts = {
    speakers: zero(),
    contributors: zero(),
    utterancesWithoutAgreement: 0,
    speakersWithoutAccount: 0,
  };
  for (const s of speakers) {
    counts.speakers[s.releaseState] += 1;
    if (s.releaseState !== 'agreed') counts.utterancesWithoutAgreement += s.utteranceCount;
    if (!s.hasAccount) counts.speakersWithoutAccount += 1;
  }
  for (const c of contributors) counts.contributors[c.releaseState] += 1;

  return { currentTermsVersion, speakers, contributors, counts };
}
