// contributorTerms.ts
//
// The one-time question every contributor answers after logging in, and the version
// stamp that makes "one time" mean once.
//
// ---------------------------------------------------------------------------
// THE WORDING BELOW IS A DRAFT AND HAS NOT BEEN THROUGH LEGAL REVIEW
// ---------------------------------------------------------------------------
// It is written to match the permissions 0019 actually records, so that what someone
// reads and what the database stores are the same claim - which is the part that
// software can get right. Whether an assignment is the correct instrument for paid
// contractors in the relevant jurisdiction, and whether this phrasing achieves one,
// is a question for Speak Nigeria's own advice. Replace the text, keep the shape, and
// bump VERSION when you do.
//
// ---------------------------------------------------------------------------
// Why the version is in the code and the acceptance is in the database
// ---------------------------------------------------------------------------
// A grant records instrument_ref - which version someone agreed to. The app compares
// that against VERSION here and asks again only when they differ. So:
//
//   the same wording, forever   asked once, at the first login after this shipped.
//   the wording changes         VERSION changes, and everyone is asked once more.
//
// That second half is the honest part, and it is the reason the version is not just a
// timestamp: consent to v1 is not consent to v2, and a re-ask is what a changed
// agreement is owed. It also means editing this text WITHOUT bumping VERSION is a
// real mistake - it silently attributes new wording to people who agreed to the old.

/** Bump on any substantive change to the wording below. Stored in
 * contribution_grants.instrument_ref, and compared against there - so it must be
 * stable, short, and never reused.
 *
 * The wording of the final point HAS changed once, without a bump, while v1 was still
 * unreleased: contributions from someone who declined are now refused, so the sentence
 * promising that declining changed nothing had become false, and a consent screen that
 * misstates the consequence is worse than no screen. Editing in place was safe for exactly
 * one reason - no grant row existed anywhere, in production or locally, so there was nobody
 * whose agreement could be misattributed. That stops being true the moment one person
 * accepts, after which this constant is the only honest way to change any of it. */
export const CONTRIBUTOR_TERMS_VERSION = 'contributor-terms-v1';

export interface ContributorTermsPoint {
  /** Which stored permission this sentence is the human-readable half of. Present so a
   * reviewer can check the two against each other without reading the SQL, and so a
   * point that corresponds to nothing recorded is visibly odd. */
  records: string;
  text: string;
}

/** What the agreement says, one point per thing the database will record.
 *
 * Structured rather than one prose blob because the two have to stay in step: every
 * point below names the column it produces, and 0019 stores nothing this list does not
 * mention. Prose can drift from the schema silently; this cannot, without the drift
 * being visible on the line. */
export const CONTRIBUTOR_TERMS: ContributorTermsPoint[] = [
  {
    records: 'rights_basis = assigned',
    text:
      'The recordings you make and the examples and translations you write through this platform are ' +
      'work you are being paid for, and the rights in them are assigned to Speak Nigeria, a non-profit ' +
      'organisation building Yoruba language resources.',
  },
  {
    records: 'internal_use_permitted',
    text:
      'Speak Nigeria may use them in its own work indefinitely - in learning games, in classes, in the ' +
      'dictionary itself, and in future projects of the same kind.',
  },
  {
    records: 'open_release_permitted',
    text:
      'Speak Nigeria may also publish some of them for anyone to use, under an open licence that cannot ' +
      'be withdrawn once given. The likely first case is contributing one recording per word to Wikimedia ' +
      'Commons, so that Wiktionary entries for Yoruba words can be heard as well as read. You can say no ' +
      'to this part and yes to the rest.',
  },
  {
    records: 'attribution_required + speakers.attribution_mode',
    text:
      'If your work is published that way, you will be credited by the name you choose - your own name, ' +
      'another name, or none. You can change that choice at any time.',
  },
  {
    records: 'revoked_at',
    text:
      'You can withdraw this at any time. Withdrawing stops anything further being published, and applies ' +
      'to all of your work, not only to what comes after. It cannot recall something already published ' +
      'under an open licence, because an open licence given to the public cannot be taken back.',
  },
  {
    records: 'no_grant_reason',
    text:
      'If you do not agree, you can still sign in and read the dictionary, but you will not be able to ' +
      'record or submit work while that stands. You can change your answer at any time, and everything ' +
      'you have already contributed is kept.',
  },
];

/** The release states that stop someone contributing.
 *
 * Both are answers, and both say the same thing about publication - 'declined' before any
 * work, 'revoked' after some. Neither is 'unknown', which is deliberate and is the whole
 * reason this is a list rather than a `!== open_permitted` test: nobody who has simply not
 * been asked yet should be blocked from working, and that includes anyone whose grant
 * lookup failed. Nor is 'internal_only' - agreeing to everything except open publication is
 * a full answer, and the material it produces is exactly what the engagement is for.
 */
export const BLOCKING_RELEASE_STATES = ['declined', 'revoked'] as const;

/** Whether this release state stops someone contributing.
 *
 * Shared because both sides ask it and must agree: the API refuses the write, and the app
 * decides whether to put the agreement back in front of someone rather than let them work
 * and lose it to a 403 at save time. Two copies of this rule would produce exactly that
 * mismatch - a screen that lets you record and a server that will not keep it. */
export function blocksContribution(releaseState: string | null | undefined): boolean {
  return (BLOCKING_RELEASE_STATES as readonly string[]).includes(releaseState ?? '');
}

/** Whether an account has to be asked. True when there is no grant, or when the one
 * there is answered a different version of the wording.
 *
 * Exported rather than inlined at each call site because both sides ask it: the API
 * reports it, and the app decides whether to interrupt on it, and the two disagreeing
 * would mean a prompt that reappears forever or one that never appears at all. */
export function needsContributorTerms(acceptedVersion: string | null | undefined): boolean {
  return acceptedVersion !== CONTRIBUTOR_TERMS_VERSION;
}
