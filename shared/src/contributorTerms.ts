// contributorTerms.ts
//
// The one-time question every contributor answers after logging in, and the version
// stamp that makes "one time" mean once.
//
// ---------------------------------------------------------------------------
// Adapted from two established templates, and still not legal advice
// ---------------------------------------------------------------------------
// The earlier draft here was written from scratch, which is the wrong way to resolve
// legal doubt without a lawyer. This one is adapted from two documents that exist to
// be reused:
//
//   Duke's basic oral history release
//     https://sites.duke.edu/archivox/2015/01/29/oral-history-basic-release-template/
//     Chosen for the domain fit - a person records their voice, an institution takes
//     the rights - and for plain language aimed at people who are not lawyers. Its
//     Option 2 is the operative model, including the licence BACK to the contributor:
//     "I hereby transfer copyright to the Library, which grants me a non-exclusive
//     license for the complete and unrestricted right to reproduce, publish,
//     broadcast, transmit, perform or adapt the interview."
//
//   Project Harmony's individual contributor ASSIGNMENT agreement (HA-CAA-I)
//     https://www.harmonyagreements.org/  (templates are CC-BY-3.0)
//     Two ideas taken from it: the same licence back (its 2.1(d)), and the fallback in
//     2.1(b-c) for jurisdictions that do not permit copyright to be assigned, where
//     the agreement operates as an exclusive licence instead. That single sentence is
//     the most valuable thing either template contributes, and it is the reason to
//     start from one rather than from a blank page.
//
// It is still adapted rather than reviewed. Speak Nigeria's own advice governs.
//
// ---------------------------------------------------------------------------
// Three drafting rules, each of which the first attempt broke
// ---------------------------------------------------------------------------
//   1. The verb list in point 2 is Duke's almost verbatim. An established template
//      already solved "name the uses without naming a destination".
//   2. "including but not limited to" in point 3 is load-bearing, not padding. An
//      illustrative list needs an explicit non-exhaustive marker or ejusdem generis
//      lets it be read as the LIMIT of the general phrase before it. The first draft
//      named only Wikimedia Commons, which would have read as the boundary of what was
//      agreed to; the courses and the games are neither of them Commons.
//   3. No em dashes. They read as an aside, and these documents are written with
//      commas, semicolons and parentheses. This file only - the repo's code comments
//      keep their existing " - " house style.
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
// That second half is the honest part: consent to v1 is not consent to v2, and a
// re-ask is what a changed agreement is owed.

/** Bump on any substantive change to the wording below. Stored in
 * contribution_grants.instrument_ref, and compared against there - so it must be
 * stable, short, and never reused.
 *
 * Still v1 despite this file being rewritten, and safe for exactly one reason: no grant
 * row exists anywhere. Production does not yet have the table, so there is nobody whose
 * agreement could be misattributed to wording they never read. That stops being true the
 * moment one person accepts, after which this constant is the only honest way to change
 * any of the text below. */
export const CONTRIBUTOR_TERMS_VERSION = 'contributor-terms-v1';

/** What the agreement says.
 *
 * A plain list of sentences. It used to carry a `records` annotation per point, naming the
 * column that point produced, so the text and the schema could be checked against each
 * other. That was worth having when a contributor answered four separate permission
 * questions; now that everything is assigned outright there is one boolean behind the whole
 * list, and the annotation was describing a complexity that no longer exists. */
export const CONTRIBUTOR_TERMS: string[] = [
  'This agreement covers everything you record or write in this portal, including recordings, ' +
    'example sentences, translations and definitions.',

  'You transfer to Speak Nigeria, a non-profit organisation building Yoruba language resources, ' +
    'the copyright in that material, together with permission to reproduce, publish, broadcast, ' +
    'transmit, perform and adapt your voice in it.',

  'Speak Nigeria may use that material for any purpose, including but not limited to its courses, ' +
    'the learning games it builds, and freely licensed reference works such as Wiktionary. Speak ' +
    'Nigeria may release it to the public under an open licence that anyone is free to reuse.',

  'Speak Nigeria grants you a non-exclusive licence to use your own contributions for any purpose, ' +
    'without restriction.',

  'Where the law does not permit copyright to be transferred, this agreement operates instead as an ' +
    'exclusive licence to Speak Nigeria for the full term of copyright.',
];

/** Whether an account has to be asked. True when there is no grant, or when the one
 * there is answered a different version of the wording.
 *
 * Exported rather than inlined at each call site because both sides ask it: the API
 * reports it, and the app decides whether to interrupt on it, and the two disagreeing
 * would mean a prompt that reappears forever or one that never appears at all. */
export function needsContributorTerms(acceptedVersion: string | null | undefined): boolean {
  return acceptedVersion !== CONTRIBUTOR_TERMS_VERSION;
}

/** The release states that stop someone contributing.
 *
 * Both are answers, and both say the same thing about publication - 'declined' before any
 * work, 'revoked' after some. Neither is 'unknown', which is deliberate and is the whole
 * reason this is a list rather than a `!== agreed` test: nobody who has simply not been
 * asked yet should be blocked from working, and that includes anyone whose grant lookup
 * failed.
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
