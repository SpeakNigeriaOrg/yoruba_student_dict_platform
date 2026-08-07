// handlers/resolveOrRequestComponent.ts
//
// Turns "the part I mean is this Wiktionary etymology" into a word_id a volunteer's etymology
// submission can point at - creating a request for the curators if we do not hold that word.
//
// ---------------------------------------------------------------------------
// The dead end this removes
// ---------------------------------------------------------------------------
// The component picker searched only our own 92-word vocabulary, so a volunteer who knew
// `adìyẹ` appears in `abo adìyẹ` was told to ask a curator and could not finish the task. The
// knowledge they had went nowhere. Now the picker searches the whole corpus, and a pick that
// we do not hold becomes a queued request while the etymology submission proceeds.
//
// ---------------------------------------------------------------------------
// Why the decision has to be made HERE
// ---------------------------------------------------------------------------
// Only the server sees production and the corpus at once, and the three outcomes below all
// depend on that pairing. Deciding in the client would mean shipping it the whole citation
// table.
//
//   already cited by a word    RESOLVE. The common case, and not a coincidence: the derived id
//                              reproduces production's own convention, so 55 corpus entries
//                              already derive an id we hold. Requesting a duplicate would be
//                              the wrong answer.
//   derived id is free         REQUEST it under that id.
//   derived id is CLAIMED - by
//   a word, or by another
//   etymology's pending
//   request                    a genuine collision (262 corpus entries, 4.2%, nearly all
//                              Wiktionary letter-name and pronoun entries). Discriminate, then
//                              request. Deterministic because every rung is a pure function of
//                              the etymology, and paid only where it is actually needed.
//
// The request is a `new_entry` contribution - the queue for this already existed and is already
// curator-approvable. Approving it creates the word at exactly the id returned here, so every
// etymology contribution referencing it resolves with no further action. That is the whole
// flow-back mechanism.

import {
  deriveWordId,
  discriminateWordId,
  hashDiscriminateWordId,
  isCitableEntryId,
  syllabifyWord,
} from '@yoruba-student-dict-platform/shared';
import { trySavepoint, type Queryable } from '../db.js';
import { loadEntryClaim } from '../entryClaims.js';
import { loadSenseByEntryId } from '../kaikkiData.js';
import { EntryIdNotCitableError, EntryIdNotInCorpusError } from './upstreamCitations.js';
import { submitContributionInTransaction } from './submitContribution.js';

export interface ResolveOrRequestResult {
  /** The word_id the caller should use as a component. Already exists when
   * `outcome` is 'resolved'; will exist once a curator approves otherwise. */
  wordId: string;
  outcome: 'resolved' | 'requested' | 'already_requested';
  displayText: string;
  /** Set when a request was created (or already existed), so the UI can say what is pending. */
  contributionId?: string;
}

export async function resolveOrRequestComponent(
  client: Queryable,
  entryId: string,
  requestedBy: string,
): Promise<ResolveOrRequestResult> {
  // A `generated-` id tracks ingest processing order rather than an etymology, so it can point
  // somewhere else after any re-ingest. Refused here as everywhere else a citation is written.
  if (!isCitableEntryId(entryId)) throw new EntryIdNotCitableError(entryId);

  const sense = await loadSenseByEntryId(client, entryId);
  if (!sense) throw new EntryIdNotInCorpusError(entryId);

  const displayText = sense.canonicalForm.value;
  const gloss = sense.glosses[0];

  // 1 & 2. Is this etymology already someone's identity - a word we hold, or a request already
  //         standing? Both are the same question, and it is now asked through entryClaims.ts so the
  //         curator search asks it the same way. A standing request returns the SAME planned id
  //         rather than a second request: two volunteers naming the same missing part must agree.
  const claim = await loadEntryClaim(client, entryId);
  if (claim?.status === 'in_dictionary') {
    return { wordId: claim.wordId, outcome: 'resolved', displayText: claim.displayText };
  }
  if (claim?.status === 'requested') {
    return { wordId: claim.wordId, outcome: 'already_requested', displayText, contributionId: claim.contributionId };
  }

  // 3. Pick the id. Discriminate only if the base is already claimed - step 1 and 2 returned for
  //    the same-etymology cases, so a claim here belongs to a DIFFERENT etymology.
  const wordId = await pickFreeWordId(client, deriveWordId(displayText, gloss), entryId);

  // Under a savepoint, because losing the race is a NORMAL outcome here, not an error. 0017 makes
  // one-open-request-per-etymology a real constraint, and the check above is still a read-then-write:
  // read committed does not serialise it, so two volunteers asking at the same moment both pass step 2.
  // The loser wants the same answer as if it had arrived a moment later - already_requested, naming the
  // request that won - and it cannot ask who won without a savepoint to recover the transaction.
  const inserted = await trySavepoint(client, 'request_component', () =>
    submitContributionInTransaction(
      client,
      {
        axis: 'new_entry',
        proposedValue: {
          proposedWordId: wordId,
          displayText,
          syllables: syllablesFor(displayText),
          type: 'word',
          definition: gloss,
          citation: { entryId },
        },
        note: 'Requested from the etymology axis as a missing component.',
      },
      requestedBy,
    ),
  );

  if (inserted === null) {
    const winner = await loadEntryClaim(client, entryId);
    if (winner?.status === 'requested') {
      return { wordId: winner.wordId, outcome: 'already_requested', displayText, contributionId: winner.contributionId };
    }
    // A word appeared for this etymology mid-flight (a curator adding it directly, which also closes
    // requests) - so it is resolved, not requested.
    if (winner?.status === 'in_dictionary') {
      return { wordId: winner.wordId, outcome: 'resolved', displayText: winner.displayText };
    }
    // Neither: the collision was on the planned word_id from a request for a DIFFERENT etymology.
    // Nothing here can name a correct answer, so let it surface rather than inventing one.
    throw new CannotDeriveFreeWordIdError(wordId);
  }

  return { wordId, outcome: 'requested', displayText, contributionId: inserted.contributionId };
}

/** Syllabified here rather than left to the curator: the word needs a split for its audio axis
 * anyway, and this is the same function that produced every other word's. Falls back to the
 * whole form for something unsyllabifiable (Ajami, hyphenated), which a curator can fix. */
function syllablesFor(displayText: string): string[] {
  const syllables = syllabifyWord(displayText);
  return syllables.length > 0 ? syllables : [displayText];
}

export class CannotDeriveFreeWordIdError extends Error {
  constructor(baseId: string) {
    super(`could not derive an unclaimed word_id from "${baseId}" - a curator needs to add this word directly`);
    this.name = 'CannotDeriveFreeWordIdError';
  }
}

/** Is this word_id spoken for by anything - an existing word, or another etymology's pending
 * request?
 *
 * The second half is the one that is easy to miss, and it is not hypothetical. 262 corpus entries
 * (4.2%) share a derived id with another entry. Two volunteers requesting two of those, before
 * either is approved, would both find the base id absent from golden_record and both get it -
 * two different etymologies queued under one word_id, with component references that no longer
 * say which was meant. Checking pending requests too is what closes that. */
async function isWordIdClaimed(client: Queryable, wordId: string): Promise<boolean> {
  const { rows } = await client.query<{ claimed: boolean }>(
    `select exists (select 1 from golden_record where word_id = $1)
         or exists (
           select 1 from contributions
           where axis = 'new_entry' and status = 'active' and proposed_value ->> 'proposedWordId' = $1
         ) as claimed`,
    [wordId],
  );
  return rows[0].claimed;
}

/** The first unclaimed id from base → entry-token → entry-hash.
 *
 * Every rung is a pure function of the etymology, so two volunteers picking it see the same
 * production state and land on the same id - which is what the consensus tally compares. The
 * third rung exists because the second is not always enough; see hashDiscriminateWordId. */
async function pickFreeWordId(client: Queryable, baseId: string, entryId: string): Promise<string> {
  const candidates = [baseId, discriminateWordId(baseId, entryId), hashDiscriminateWordId(baseId, entryId)];
  for (const candidate of candidates) {
    if (!(await isWordIdClaimed(client, candidate))) return candidate;
  }
  // Unreachable short of a deliberate collision on a 32-bit hash of the entry id. Thrown rather
  // than returning a claimed id, which would silently merge two etymologies.
  throw new CannotDeriveFreeWordIdError(baseId);
}

// ---------------------------------------------------------------------------
// The word Wiktionary does not have either
// ---------------------------------------------------------------------------
// The rare path, and it must stay rare: the preferred fix for a word missing from Wiktionary is
// an upstream edit, which happens outside this app. But refusing the request outright would put
// the volunteer back in the dead end this whole handler exists to remove, for the one case where
// they are the only person who knows the word.
//
// So it is recorded the same way as everything else, with one difference: the citation is
// EXEMPT rather than an entry id. Per 0014 that is not a gap - it is the durable, queryable
// record that this word awaits a Wiktionary entry, which is exactly what makes the eventual
// re-link findable (reconcileUpstream lists exempt words) instead of needing a new workflow.
export const NO_UPSTREAM_ENTRY_REASON = 'Requested by a volunteer; no Wiktionary entry found for it yet';

export class DisplayTextRequiredError extends Error {
  constructor() {
    super('the word itself is required');
    this.name = 'DisplayTextRequiredError';
  }
}

export class DefinitionRequiredError extends Error {
  constructor() {
    super('an English definition is required - a word with no meaning cannot be reviewed');
    this.name = 'DefinitionRequiredError';
  }
}

export class WordAlreadyInDictionaryError extends Error {
  constructor(public readonly wordId: string) {
    // Not discriminated into a second id, deliberately. A collision here means same spelling AND
    // same first-clause meaning, with no etymology to tell the two apart - which for an unlisted
    // word means it is almost certainly the word we already hold. Guessing either way would be
    // silent; saying so sends the volunteer back to the search, where they will find it.
    super('a word with this spelling and meaning is already in the dictionary - search for it instead');
    this.name = 'WordAlreadyInDictionaryError';
  }
}

export async function requestUnlistedComponent(
  client: Queryable,
  input: { displayText: string; definition: string },
  requestedBy: string,
): Promise<ResolveOrRequestResult> {
  // NFC because the composer's tone grid emits NFC but a pasted spelling may be NFD, and the
  // same word written both ways must not become two words. Five production rows already store
  // NFD text from before this was enforced.
  const displayText = input.displayText.normalize('NFC').trim();
  const definition = input.definition.trim();
  if (!displayText) throw new DisplayTextRequiredError();
  if (!definition) throw new DefinitionRequiredError();

  const wordId = deriveWordId(displayText, definition);

  // Same agreement requirement as the cited path, keyed on the derived id because there is no
  // entry id to key on. Two volunteers who write the same word with the same meaning derive the
  // same id and therefore land on the same request.
  const pending = await client.query<{ contribution_id: string }>(
    `select contribution_id
     from contributions
     where axis = 'new_entry' and status = 'active' and proposed_value ->> 'proposedWordId' = $1
     limit 1`,
    [wordId],
  );
  if (pending.rows.length > 0) {
    return { wordId, outcome: 'already_requested', displayText, contributionId: pending.rows[0].contribution_id };
  }

  const taken = await client.query('select 1 from golden_record where word_id = $1', [wordId]);
  if ((taken.rowCount ?? 0) > 0) throw new WordAlreadyInDictionaryError(wordId);

  const { contributionId } = await submitContributionInTransaction(
    client,
    {
      axis: 'new_entry',
      proposedValue: {
        proposedWordId: wordId,
        displayText,
        syllables: syllablesFor(displayText),
        type: 'word',
        definition,
        citation: { exemptReason: NO_UPSTREAM_ENTRY_REASON },
      },
      note: 'Requested from the etymology axis: not found in Wiktionary.',
    },
    requestedBy,
  );

  return { wordId, outcome: 'requested', displayText, contributionId };
}
