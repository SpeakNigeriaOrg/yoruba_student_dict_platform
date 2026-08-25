// screens/ClaimViews.tsx
//
// How one claim about a word reads to the curator who has to choose between claims.
//
// ---------------------------------------------------------------------------
// Why this is its own file
// ---------------------------------------------------------------------------
// There are two places a curator sets the record - the bulk queue (ReviewQueue) and one
// word's dossier (WordDossier) - and they had two different renderers for the same thing.
// The queue showed the claim. The dossier showed a vote count and a list of usernames, and
// nothing else: no spelling, no syllables, no definition, no components. So the question the
// dossier was asking - "which of these is correct?" - could only be answered there by
// knowing who to trust, which is precisely the model this project rejected when it stopped
// asking "is this person right?" and started asking "what is true?".
//
// One renderer, so the two screens cannot drift back apart.
//
// ---------------------------------------------------------------------------
// Ids are not labels
// ---------------------------------------------------------------------------
// Two of the fields a claim asserts are stored as keys and were shown as keys, or not at
// all:
//
//   - an etymology claim's components are word_ids (`oju_eye`), which are
//     orthography-INSENSITIVE by construction - the tone marks are stripped out of them.
//     Tone is the single most common thing a curator is adjudicating, so the id is missing
//     exactly the information the decision turns on.
//   - an entry claim's citedEntryId is an opaque upstream token, and it was rendered
//     nowhere. It is part of the fingerprint and it is reported in differingFields, so two
//     claims that disagree ONLY about which etymology this word is - the `kọ́` case this
//     whole citation model exists for - rendered as two identical-looking rows with
//     different vote counts.
//
// listConsensus now resolves both to something readable and hands them down as
// `group.labels`. The raw id is the fallback, never the first choice.

import type { ConsensusLabels, EtymologyLabel } from '../api.js';
import type {
  ClaimField,
  ConsensusSummary,
  ConsensusTallyEntry,
  ContributionOutcome,
} from '@yoruba-student-dict-platform/shared';

const NO_LABELS: ConsensusLabels = { components: {}, etymologies: {} };

/** One cited etymology, the way the Add Word screen writes it, so the same etymology reads
 * the same wherever a human meets it. Falls back to the bare id for a citation whose corpus
 * row has gone - which is a real state (the corpus is re-ingested and truncated), and one
 * worth showing as itself rather than hiding. */
export function CitedEtymology({ entryId, label }: { entryId: string; label?: EtymologyLabel }) {
  if (!label) {
    return (
      <span className="word-id" title="not in the current corpus">
        {entryId}
      </span>
    );
  }
  return (
    <span>
      <strong>{label.form}</strong> ({label.pos}
      {label.etymologyNumber ? `, etymology ${label.etymologyNumber}` : ''})
      {label.glosses.length > 0 ? ` - ${label.glosses.join('; ')}` : ''}
    </span>
  );
}

/** The parts an etymology claim names, spelled as the dictionary spells them.
 *
 * `oju + ile` and `ojú + ilé` are the same claim to the database and different claims to a
 * reader, and the reader is the one being asked to approve it. */
function ComponentList({ components, labels }: { components: string[]; labels: Record<string, string> }) {
  if (components.length === 0) return <em>no components</em>;
  return (
    <>
      {components.map((id, i) => (
        <span key={`${i}-${id}`}>
          {i > 0 ? ' + ' : ''}
          <strong>{labels[id] ?? id}</strong>
          {/* The id as well as the spelling, quietly. Two etymologies can share a spelling,
              so the spelling alone does not say WHICH word was named - and a curator
              checking that is checking the id. */}
          {labels[id] ? <span className="word-id"> {id}</span> : null}
        </span>
      ))}
    </>
  );
}

/** Renders an outcome as the claim it is, rather than as the action that
 * produced it - the curator is comparing assertions about a word, and two
 * routes to the same assertion should look identical here. */
export function OutcomeSummary({
  outcome,
  labels = NO_LABELS,
}: {
  outcome: ContributionOutcome;
  /** Resolved from the claim's own group. Optional so a caller with nothing to resolve -
   * a test, or a screen that has not been given them - still renders, with raw ids. */
  labels?: ConsensusLabels;
}) {
  if (outcome.kind === 'etymology') {
    return (
      <span>
        {outcome.atomic ? (
          <em>no parts (atomic)</em>
        ) : (
          <ComponentList components={outcome.components} labels={labels.components} />
        )}
      </span>
    );
  }
  return (
    <span>
      <strong>{outcome.displayText}</strong>
      <span className="outcome-syllables"> {outcome.syllables.join(' · ')}</span>
      <br />
      {outcome.definitionText ?? <em>(no definition)</em>}
      {/* Below the definition rather than beside the spelling: it is the claim's identity,
          not a detail of its wording, and burying it inline made the one case it exists for
          - two claims that agree on every word and disagree on which word it is - invisible. */}
      <div className="field-note">
        {outcome.citedEntryId ? (
          <>
            cites <CitedEtymology entryId={outcome.citedEntryId} label={labels.etymologies[outcome.citedEntryId]} />
          </>
        ) : (
          <em>cites no Wiktionary etymology</em>
        )}
      </div>
    </span>
  );
}

const FIELD_LABELS: Record<ClaimField, string> = {
  spelling: 'the spelling',
  syllables: 'the syllable split',
  definition: 'the student definition',
  etymology: 'which etymology it cites',
  components: 'the components',
};

/** What the competing claims are actually arguing about.
 *
 * A contested word used to say only that it was contested, so telling a tone-mark dispute from two
 * people wording a gloss differently meant opening the word and diffing the claims by eye.
 *
 * The wording-only case gets its own sentence because it is a different kind of question. Spelling,
 * syllables and cited etymology are identity - one right answer, and a difference is a conflict. A
 * student definition is a rendering, and two good ones can disagree. When the identity is unanimous
 * the curator is picking the better sentence, not adjudicating a dispute, and saying so up front is
 * the difference between a queue of arguments and a queue of small editorial choices. */
export function DisagreementNote({ summary }: { summary: ConsensusSummary }) {
  if (summary.differingFields.length === 0) return null;
  const names = summary.differingFields.map((f) => FIELD_LABELS[f]);
  const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  if (summary.wordingOnly) {
    return (
      <p className="field-note" aria-label="Wording only">
        <strong>Same word, different wording.</strong> Every claim agrees on the spelling, the syllables and the
        etymology, and they differ only in how the student definition is worded — so this is a choice between good
        sentences, not a conflict to settle.
      </p>
    );
  }
  return (
    <p className="field-note" aria-label="What differs">
      They differ on {joined}.
    </p>
  );
}

/** What the record says right now, next to the claims that propose changing it.
 *
 * A tally with no baseline asks the curator to choose between three spellings without
 * saying which one the dictionary already holds - so "set the record to this" could not be
 * told apart from "leave the record alone", and the no-op looked like a decision.
 *
 * Only the fields the axis is actually about: an etymology tally has no business restating
 * the student definition, and an entry tally has none restating the components. */
export function CurrentRecord({
  axis,
  displayText,
  syllables,
  definition,
  citedEntryId,
  components,
  labels = NO_LABELS,
}: {
  axis: 'entry' | 'etymology';
  displayText: string;
  syllables: string[];
  definition: string | null;
  citedEntryId: string | null;
  /** Only meaningful on the etymology axis, and only where the caller holds them. */
  components?: string[];
  labels?: ConsensusLabels;
}) {
  return (
    <div className="claim-current" aria-label="What the record says now">
      <div className="claim-votes">
        <span className="field-note">on record</span>
      </div>
      <div className="claim-outcome">
        {axis === 'etymology' ? (
          components === undefined ? (
            <em>not shown</em>
          ) : components.length === 0 ? (
            <em>no parts (atomic)</em>
          ) : (
            <ComponentList components={components} labels={labels.components} />
          )
        ) : (
          <>
            <strong>{displayText}</strong>
            <span className="outcome-syllables"> {syllables.join(' · ')}</span>
            <br />
            {definition ?? <em>(no definition)</em>}
            <div className="field-note">
              {citedEntryId ? (
                <>
                  cites <CitedEtymology entryId={citedEntryId} label={labels.etymologies[citedEntryId]} />
                </>
              ) : (
                <em>cites no Wiktionary etymology</em>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ClaimRow({
  claim,
  isWinner,
  onChoose,
  chooseLabel,
  busy,
  labels,
}: {
  claim: ConsensusTallyEntry;
  isWinner: boolean;
  onChoose?: () => void;
  /** What choosing this claim actually does, which is not the same act in every section.
   *
   * It used to read "Use this" everywhere: in Conflicts, where it settles a disagreement
   * between two people who have both looked; and in One vote only, where it puts a single
   * unchecked opinion on the record. Same button, same styling, same words. The only thing
   * telling them apart was a blurb at the top of the section, scrolled off by the time you
   * reached the button on a phone. */
  chooseLabel: string;
  busy: boolean;
  labels?: ConsensusLabels;
}) {
  return (
    <li className={`claim${isWinner ? ' claim-winner' : ''}`}>
      <div className="claim-votes">
        <span className="figure">{claim.count}</span> {claim.count === 1 ? 'vote' : 'votes'}
      </div>
      <div className="claim-outcome">
        <OutcomeSummary outcome={claim.outcome} labels={labels} />
        {claim.voterLabels.length > 0 ? <div className="claim-voters">{claim.voterLabels.join(', ')}</div> : null}
      </div>
      {onChoose ? (
        <button type="button" className="btn btn-secondary" onClick={onChoose} disabled={busy}>
          {chooseLabel}
        </button>
      ) : null}
    </li>
  );
}
