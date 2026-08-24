// screens/ReviewQueue.tsx
//
// The curator's review surface, replacing ContributionQueue.
//
// ContributionQueue listed individual submissions with Approve/Reject on each,
// which asked the curator "is this person right?". This lists one row per
// (word, axis) and asks "what does the evidence say?" - the question that
// scales past a handful of contributors, and the one actually worth answering.
//
// Four sections, ordered by what deserves human attention rather than by time:
//
//   1. Conflicts        - people disagree. Highest priority, always.
//   2. Dissent on golden- a settled word has been contradicted since.
//   3. Ready to confirm - enough agreement to wave through in bulk.
//   4. Single vote      - provisional, but nobody has corroborated it.
//
// Bulk confirmation is a curator-on-desktop affordance, so on a phone it
// degrades to a plain checkable list rather than a wide table - each row stays
// one tappable decision.

import { useCallback, useEffect, useState } from 'react';
import {
  approveContribution,
  backfillAuthoringVotes,
  confirmConsensus,
  excludeContribution,
  getConsensus,
  getContributions,
  getUpstreamDrift,
  repinUpstream,
  type ContributionListItem,
  type DriftItem,
  type ExemptItem,
  type NewEntryProposal,
  type UpstreamDriftResult,
  type ConfirmConsensusResult,
  type ConsensusGroup,
  type AuthoringVoteBackfillResult,
} from '../api.js';
import type {
  ClaimField,
  ConsensusBucket,
  ConsensusSummary,
  ConsensusTallyEntry,
  ContributionOutcome,
} from '@yoruba-student-dict-platform/shared';

/** `chooseLabel` is per section rather than one shared word, because choosing a claim is a
 * different act in each: settling a live argument, overriding a decision you already made,
 * or promoting something nobody else has checked. The button now says which. */
const SECTIONS: Array<{ bucket: ConsensusBucket; title: string; blurb: string; chooseLabel: string }> = [
  {
    bucket: 'contested',
    title: 'Conflicts',
    blurb: 'Contributors disagree. Pick the right answer, or decide it yourself.',
    chooseLabel: 'Settle it with this',
  },
  {
    bucket: 'dissent_on_golden',
    title: 'Disputed after being settled',
    blurb: 'Someone has contradicted a decision you already made. The decision still stands until you act.',
    chooseLabel: 'Change the record to this',
  },
  {
    bucket: 'ready',
    title: 'Ready to confirm',
    blurb: 'Contributors agree. Confirm in bulk.',
    chooseLabel: 'Set the record to this',
  },
  {
    bucket: 'single',
    title: 'One vote only',
    blurb: 'Provisional. Nobody has corroborated these yet - confirm, or leave them to gather a second opinion.',
    chooseLabel: 'Set the record on one vote',
  },
];

/** Renders an outcome as the claim it is, rather than as the action that
 * produced it - the curator is comparing assertions about a word, and two
 * routes to the same assertion should look identical here. */
function OutcomeSummary({ outcome }: { outcome: ContributionOutcome }) {
  if (outcome.kind === 'etymology') {
    return (
      <span>
        {outcome.atomic ? (
          <em>no parts (atomic)</em>
        ) : outcome.components.length === 0 ? (
          <em>no components</em>
        ) : (
          outcome.components.join(' + ')
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
function DisagreementNote({ summary }: { summary: ConsensusSummary }) {
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

function ClaimRow({
  claim,
  isWinner,
  onChoose,
  chooseLabel,
  busy,
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
}) {
  return (
    <li className={`claim${isWinner ? ' claim-winner' : ''}`}>
      <div className="claim-votes">
        <span className="figure">{claim.count}</span> {claim.count === 1 ? 'vote' : 'votes'}
      </div>
      <div className="claim-outcome">
        <OutcomeSummary outcome={claim.outcome} />
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

export interface ReviewQueueProps {
  /** Opens the full word screen, for a conflict a curator would rather resolve
   * by working the entry themselves than by picking someone's answer. */
  onOpenWord: (wordId: string, axis: 'entry' | 'etymology') => void;
}

export function ReviewQueue({ onOpenWord }: ReviewQueueProps) {
  const [groups, setGroups] = useState<ConsensusGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConfirmConsensusResult | null>(null);
  const [drift, setDrift] = useState<UpstreamDriftResult | null>(null);
  const [requests, setRequests] = useState<ContributionListItem[]>([]);

  const key = (g: ConsensusGroup) => `${g.wordId}:${g.axis}`;

  const load = useCallback(async () => {
    try {
      const fetched = await getConsensus();
      setGroups(fetched);
      setSelected(new Set());
      return fetched;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  /** Loaded separately from the consensus queue, and its failure is deliberately
   * not fatal to the page: drift is a background health check, and a corpus that
   * cannot be read should not take the curator's actual work queue down with it. */
  const loadDrift = useCallback(async () => {
    try {
      setDrift(await getUpstreamDrift());
    } catch {
      setDrift(null);
    }
  }, []);

  /** Requested word additions - 'new_entry' contributions. Loaded separately and non-fatally for
   * the same reason as drift: this is a queue alongside the curator's main work, not a
   * precondition for seeing it. */
  const loadRequests = useCallback(async () => {
    try {
      setRequests((await getContributions('active')).filter((c) => c.axis === 'new_entry'));
    } catch {
      setRequests([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadDrift();
    void loadRequests();
  }, [load, loadDrift, loadRequests]);

  async function confirm(items: Array<{ group: ConsensusGroup; fingerprint: string }>) {
    if (items.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await confirmConsensus(
        // expectedFingerprint on every item: the server refuses anything whose
        // winning claim moved while this list was on screen, rather than
        // writing a decision nobody voted for.
        items.map(({ group, fingerprint }) => ({
          wordId: group.wordId,
          axis: group.axis,
          expectedFingerprint: fingerprint,
        })),
      );
      setResult(outcome);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <p role="alert" className="error-banner">
        Couldn't load the review queue: {error}
      </p>
    );
  if (!groups) return <p>Loading the review queue...</p>;

  const bySection = SECTIONS.map((section) => ({
    ...section,
    groups: groups.filter((g) => g.summary.bucket === section.bucket),
  }));
  const total = groups.length;

  const readyGroups = bySection.find((s) => s.bucket === 'ready')?.groups ?? [];
  const selectedReady = readyGroups.filter((g) => selected.has(key(g)));

  function toggle(g: ConsensusGroup) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = key(g);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  return (
    <section aria-label="Review queue">
      {total === 0 ? (
        <p>Nothing waiting on you. Every word is either settled or untouched.</p>
      ) : (
        <p className="queue-progress" aria-label="Review queue size">
          {total} {total === 1 ? 'word needs' : 'words need'} your attention
        </p>
      )}

      {result ? (
        <p role="status" className="status-banner">
          Confirmed {result.confirmed.length}.
          {result.skipped.length > 0
            ? ` Skipped ${result.skipped.length}: ${result.skipped
                .map((s) => `${s.wordId} (${s.reason.replace(/_/g, ' ')})`)
                .join('; ')}.`
            : ''}
        </p>
      ) : null}

      {bySection.map((section) =>
        section.groups.length === 0 ? null : (
          <div key={section.bucket} className="review-section">
            <h3>
              {section.title} ({section.groups.length})
            </h3>
            <p className="field-note">{section.blurb}</p>

            {section.bucket === 'ready' ? (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || selectedReady.length === 0}
                  onClick={() =>
                    void confirm(
                      selectedReady
                        .filter((g) => g.summary.winner)
                        .map((g) => ({ group: g, fingerprint: g.summary.winner!.fingerprint })),
                    )
                  }
                >
                  {busy ? 'Confirming...' : `Confirm ${selectedReady.length || ''} selected`.trim()}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    setSelected(selectedReady.length === section.groups.length ? new Set() : new Set(section.groups.map(key)))
                  }
                >
                  {selectedReady.length === section.groups.length ? 'Clear all' : 'Select all'}
                </button>
              </div>
            ) : null}

            <ul aria-label={section.title} className="card-list">
              {section.groups.map((g) => (
                <li key={key(g)} className="card-row">
                  <div className="review-head">
                    {section.bucket === 'ready' ? (
                      <label className="field-inline">
                        <input
                          type="checkbox"
                          checked={selected.has(key(g))}
                          onChange={() => toggle(g)}
                          aria-label={`Select ${g.displayText}`}
                        />
                      </label>
                    ) : null}
                    <button type="button" className="row-title" onClick={() => onOpenWord(g.wordId, g.axis)}>
                      {g.displayText}
                    </button>
                    <span className="badge">{g.axis}</span>
                  </div>

                  <DisagreementNote summary={g.summary} />

                  <ul aria-label={`Claims for ${g.displayText}`} className="plain-list claim-list">
                    {g.summary.tally.map((claim) => (
                      <ClaimRow
                        key={claim.fingerprint}
                        claim={claim}
                        isWinner={claim.fingerprint === g.summary.winner?.fingerprint}
                        busy={busy}
                        // A one-click resolution is offered wherever a claim can
                        // be chosen: on conflicts and dissent that is the point,
                        // and on a single vote it saves opening the word.
                        chooseLabel={section.chooseLabel}
                        onChoose={
                          section.bucket === 'ready'
                            ? undefined
                            : () => void confirm([{ group: g, fingerprint: claim.fingerprint }])
                        }
                      />
                    ))}
                  </ul>

                  {g.summary.bucket === 'dissent_on_golden' ? (
                    <p className="field-note">
                      Settled{g.decidedByEmail ? ` by ${g.decidedByEmail}` : ''}
                      {g.decidedAt ? ` on ${new Date(g.decidedAt).toLocaleDateString()}` : ''}. The claims above arrived
                      after that.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}

      <RequestedWordsSection
        requests={requests}
        busy={busy}
        onAct={async (action) => {
          setBusy(true);
          try {
            await action();
            // Both queues move: approving a request creates a word, which is what unblocks the
            // etymology submissions naming it.
            await Promise.all([loadRequests(), load(), loadDrift()]);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />

      <UpstreamDriftSection
        drift={drift}
        busy={busy}
        onOpenWord={(wordId) => onOpenWord(wordId, 'entry')}
        onRepin={async (wordId, entryId) => {
          setBusy(true);
          try {
            await repinUpstream(wordId, entryId);
            await loadDrift();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />

      <AuthoringVoteBackfillSection />
    </section>
  );
}

/** The one-off backfill, as two buttons instead of a shell and a production connection string.
 *
 * Preview first, and Apply does not exist until a preview has been read: the counts ARE the
 * warning, because what makes this safe or not is entirely how many rows are in each bucket, and
 * that is not knowable in advance. A single button here would be a button whose effect nobody
 * could predict before pressing it.
 *
 * Once applied it says so and offers nothing further. Re-running is harmless - the second pass
 * plans nothing - but a button that stays lit after its job is done invites the question of
 * whether it worked the first time. */
function AuthoringVoteBackfillSection() {
  const [preview, setPreview] = useState<AuthoringVoteBackfillResult | null>(null);
  const [done, setDone] = useState<AuthoringVoteBackfillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await backfillAuthoringVotes(false));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Drives the batches, because the server will only do so many per request.
   *
   * The first real run sent all 163 in one call, outlived the HTTP gateway timeout and came back
   * 500 - having written most of them. So the loop is not only about finishing: an interrupted run
   * now reports what it got through, and every vote already committed stays committed. */
  async function runApply() {
    setBusy(true);
    setError(null);
    let written = 0;
    const failed: NonNullable<AuthoringVoteBackfillResult['failed']> = [];
    try {
      for (;;) {
        const result = await backfillAuthoringVotes(true);
        written += result.written ?? 0;
        failed.push(...(result.failed ?? []));
        const remaining = result.remaining ?? 0;
        setProgress(`Cast ${written}${remaining > 0 ? `, ${remaining} to go` : ''}...`);
        if (remaining === 0) {
          setDone({ ...result, written, failed });
          setProgress(null);
          return;
        }
        // A batch that wrote nothing and left work behind would loop forever. Report what happened
        // and stop, rather than hammering an endpoint that is not making progress.
        if ((result.written ?? 0) === 0) {
          setDone({ ...result, written, failed });
          setProgress(null);
          setError(`Stopped with ${remaining} left: the last batch wrote nothing.`);
          return;
        }
      }
    } catch (err) {
      // Whatever was written before this stays written. Say so, because the natural reading of an
      // error here is that the whole thing failed.
      setError(
        `${err instanceof Error ? err.message : String(err)} - ${written} votes were written before this and are saved. Preview again to see what is left.`,
      );
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-section" aria-label="Authoring vote backfill">
      <h3>Backfill authoring votes</h3>
      <p className="field-note">
        An entry added today records its author's position as one ordinary vote, so a volunteer who
        later disagrees makes the word <strong>contested</strong> rather than quietly outvoting
        nobody. Everything created before that holds no such vote. This casts one, attributed to
        you, for every entry that is missing one.
      </p>
      <p className="field-note">
        It runs in batches and can be stopped or interrupted at any point: every vote is saved as it
        is cast, so nothing is half-written and re-running only ever does what is left.
      </p>
      <p className="field-note">
        It writes <strong>contributions and nothing else</strong> — no spellings, components,
        citations or decisions are changed, and no audio, speaker or recording is touched. It never
        replaces a vote you have already cast, and skips any axis already decided. Running it twice
        does nothing the second time.
      </p>

      {done ? (
        <p role="status" className="status-banner">
          Wrote {done.written} votes.
          {done.failed && done.failed.length > 0
            ? ` ${done.failed.length} failed: ${done.failed.map((f) => `${f.wordId} (${f.axis})`).join(', ')}.`
            : ''}{' '}
          Words where a volunteer already disagreed with you will now show as contested — that is
          the point of it, not a problem.
        </p>
      ) : (
        <>
          {preview ? (
            <div className="warning-banner" aria-label="Backfill preview">
              <p>
                <strong>{preview.planned} votes would be cast</strong> — {preview.plannedEntry} entry,{' '}
                {preview.plannedEtymology} etymology.
              </p>
              <ul className="plain-list">
                <li>{preview.skippedNoComponents} etymology skipped — nothing on record to vote for</li>
                <li>{preview.skippedAlreadyVoted} skipped — you have already voted there</li>
                <li>{preview.skippedAlreadyDecided} skipped — the axis is already decided</li>
              </ul>
              <p className="field-note">
                Check these before applying. The entry count should be roughly your whole word list;
                a large "already voted" number means those words carry opinions you actually
                recorded, which this correctly refuses to overwrite.
              </p>
            </div>
          ) : null}

          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={runPreview} disabled={busy}>
              {preview ? 'Preview again' : 'Preview (writes nothing)'}
            </button>
            {/* Only after a preview, and only when it found something to do. */}
            {preview && preview.planned > 0 ? (
              <button type="button" className="btn btn-danger" onClick={runApply} disabled={busy}>
                Cast {preview.planned} votes
              </button>
            ) : null}
          </div>
          {progress ? (
            <p role="status" aria-label="Backfill progress">
              {progress}
            </p>
          ) : null}
          {preview && preview.planned === 0 ? (
            <p role="status">Nothing to backfill — every entry already has its author's vote.</p>
          ) : null}
        </>
      )}

      {error ? <p role="alert" className="warning-banner">{error}</p> : null}
    </div>
  );
}

/** Words volunteers have asked for, and what is waiting on each.
 *
 * The 'new_entry' contribution axis has always been the queue for this, and approveContribution
 * has always been able to apply one - but no screen listed them, so a request went somewhere
 * nobody could see. That is what this is: the missing surface, not new machinery.
 *
 * The waiting words are the part that matters. Approve-then-confirm is already enforced by
 * ComponentsNotFoundError, but a curator met it as a failure at confirmation time. Naming what is
 * blocked turns the same constraint into a reason to approve. */
function RequestedWordsSection({
  requests,
  busy,
  onAct,
}: {
  requests: ContributionListItem[];
  busy: boolean;
  onAct: (action: () => Promise<void>) => void;
}) {
  if (requests.length === 0) return null;

  return (
    <div className="review-section" aria-label="Requested words">
      <h3>Words volunteers have asked for ({requests.length})</h3>
      <p className="field-note">
        Each was requested while someone was working on another word's parts. Approving it creates the word - every
        submission already pointing at it then resolves with no further action.
      </p>
      <ul aria-label="Requested words list" className="card-list">
        {requests.map((request) => {
          const proposal = request.proposedValue as NewEntryProposal | null;
          const citation = proposal?.citation;
          const exemptReason = citation && 'exemptReason' in citation ? citation.exemptReason : null;
          return (
            <li key={request.contributionId} className="card-row">
              <div className="review-head">
                <span className="row-title">{proposal?.displayText ?? '(no spelling)'}</span>
                {/* Cited or exempt, always one of the two - 0014 makes "neither" unrepresentable,
                    and which it is decides whether this word can ever be checked upstream. */}
                <span className="badge">
                  {citation && 'entryId' in citation ? citation.entryId : exemptReason ? 'no Wiktionary entry' : 'no citation'}
                </span>
              </div>

              <p>{proposal?.definition ?? <em>(no definition)</em>}</p>
              {exemptReason ? <p className="field-note">{exemptReason}</p> : null}
              <p className="field-note">
                Asked for by {request.submittedBy} on {new Date(request.submittedAt).toLocaleDateString()}
                {proposal?.syllables?.length ? ` · ${proposal.syllables.join(' · ')}` : ''}
              </p>

              {request.waitingWords.length > 0 ? (
                <p className="field-note" aria-label={`Waiting on ${proposal?.displayText}`}>
                  Waiting on this: {request.waitingWords.map((w) => w.displayText ?? w.wordId).join(', ')}
                </p>
              ) : null}

              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => onAct(() => approveContribution(request.contributionId))}
                >
                  Add this word
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => onAct(() => excludeContribution(request.contributionId, 'not a word we should add'))}
                >
                  Decline
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Words with no Wiktionary entry, which is a recorded state rather than a gap.
 *
 * This is the other half of the volunteer word-request path: a word requested because Wiktionary
 * lacks it is stored with an exempt citation, and per 0014 that IS the durable record that it
 * awaits an upstream entry. reconcileUpstream counted these and never named them, so on the day
 * Wiktionary gained the entry there was nothing to act on. Re-linking was already one click; this
 * is the list in front of it. */
function ExemptWordsSection({ items, onOpenWord }: { items: ExemptItem[]; onOpenWord: (wordId: string) => void }) {
  // Same defensive shape guard as the drift section it sits inside: a payload from before this
  // field existed must render, not throw.
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <div aria-label="Words with no Wiktionary entry">
      <h3>Words with no Wiktionary entry ({items.length})</h3>
      <p className="field-note">
        Recorded as having none, so they are outside the upstream check by construction - not missed by it. If Wiktionary
        gains an entry for one, open the word and cite it.
      </p>
      <ul aria-label="Exempt words list" className="card-list">
        {items.map((item) => (
          <li key={item.wordId} className="card-row">
            <div className="review-head">
              <button type="button" className="row-title" onClick={() => onOpenWord(item.wordId)}>
                {item.displayText}
              </button>
            </div>
            <p className="field-note">{item.exemptReason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const DRIFT_LABELS: Record<DriftItem['kind'], { title: string; blurb: string }> = {
  unchanged: { title: '', blurb: '' },
  content_changed: {
    title: 'Wiktionary edited an etymology we cite',
    blurb:
      'The etymology is still there and still ours, but it no longer says what it said when this word was validated. Our spelling and student definition are untouched - decide whether they should follow.',
  },
  re_identified: {
    title: 'An etymology we cite moved',
    blurb:
      'The id we cited is gone, but the same content is now under a different one - a renumber or re-identification upstream. Re-linking keeps the word pointing at the etymology it always meant.',
  },
  disappeared: {
    title: 'An etymology we cite is gone',
    blurb:
      'Neither the id nor its content is in the corpus any more. Nothing can be proposed automatically; the pinned copy below is the record of what was validated.',
  },
};

const DRIFT_ORDER: Array<DriftItem['kind']> = ['disappeared', 're_identified', 'content_changed'];

/** The other half of the pin's guarantee.
 *
 * The pin makes an entry independent of upstream - it renders from a copy, so an
 * edit on Wiktionary can never silently change what we assert. Without somewhere
 * to SEE drift, that independence quietly becomes unawareness, and a citation
 * stops describing anything real. This is that somewhere. */
function UpstreamDriftSection({
  drift,
  busy,
  onOpenWord,
  onRepin,
}: {
  drift: UpstreamDriftResult | null;
  busy: boolean;
  onOpenWord: (wordId: string) => void;
  onRepin: (wordId: string, entryId: string) => void;
}) {
  // Guards the shape, not just the null: this section promises to fail quietly
  // rather than take the curator's work queue down with it, and that promise is
  // worth nothing if an unexpected payload throws during render.
  if (!drift || !Array.isArray(drift.items)) return null;

  if (drift.items.length === 0) {
    return (
      <>
        <p className="field-note" aria-label="Upstream drift status">
          Every cited etymology still matches Wiktionary ({drift.counts.unchanged} checked
          {drift.exempt > 0 ? `, ${drift.exempt} exempt` : ''}
          {drift.uncited > 0 ? `, ${drift.uncited} not linked yet` : ''}).
        </p>
        <ExemptWordsSection items={drift.exemptItems} onOpenWord={onOpenWord} />
      </>
    );
  }

  return (
    <div className="review-section" aria-label="Upstream drift">
      <ExemptWordsSection items={drift.exemptItems} onOpenWord={onOpenWord} />
      {DRIFT_ORDER.map((kind) => {
        const items = drift.items.filter((i) => i.kind === kind);
        if (items.length === 0) return null;
        return (
          <div key={kind}>
            <h3>
              {DRIFT_LABELS[kind].title} ({items.length})
            </h3>
            <p className="field-note">{DRIFT_LABELS[kind].blurb}</p>
            <ul aria-label={DRIFT_LABELS[kind].title} className="card-list">
              {items.map((item) => (
                <li key={item.wordId} className="card-row">
                  <div className="review-head">
                    <button type="button" className="row-title" onClick={() => onOpenWord(item.wordId)}>
                      {item.displayText}
                    </button>
                    <span className="badge">{item.citedEntryId}</span>
                  </div>

                  <div className="comparison" aria-label={`Upstream change for ${item.displayText}`}>
                    <div className="col">
                      <div className="col-label">Pinned when validated</div>
                      {item.pin.glosses.join('; ')}
                      {item.pin.etymologyNumber ? ` (etymology ${item.pin.etymologyNumber})` : ''}
                    </div>
                    <div className="col">
                      <div className="col-label">Wiktionary now</div>
                      {item.current ? (
                        <>
                          {item.current.glosses.join('; ')}
                          {item.current.etymologyNumber ? ` (etymology ${item.current.etymologyNumber})` : ''}
                        </>
                      ) : (
                        'not in the corpus'
                      )}
                    </div>
                  </div>

                  {item.kind === 're_identified' && item.proposedEntryId ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => onRepin(item.wordId, item.proposedEntryId!)}
                    >
                      Re-link to {item.proposedEntryId}
                    </button>
                  ) : null}

                  {item.kind === 'content_changed' ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => onRepin(item.wordId, item.citedEntryId)}
                    >
                      Accept the new upstream content
                    </button>
                  ) : null}

                  {item.kind === 'disappeared' ? (
                    <p className="field-note">
                      Open the word to re-link it to a different etymology, or record why it has none.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
