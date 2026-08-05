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
  confirmConsensus,
  getConsensus,
  type ConfirmConsensusResult,
  type ConsensusGroup,
} from '../api.js';
import type { ConsensusBucket, ConsensusTallyEntry, ContributionOutcome } from '@yoruba-student-dict-platform/shared';

const SECTIONS: Array<{ bucket: ConsensusBucket; title: string; blurb: string }> = [
  {
    bucket: 'contested',
    title: 'Conflicts',
    blurb: 'Contributors disagree. Pick the right answer, or decide it yourself.',
  },
  {
    bucket: 'dissent_on_golden',
    title: 'Disputed after being settled',
    blurb: 'Someone has contradicted a decision you already made. The decision still stands until you act.',
  },
  {
    bucket: 'ready',
    title: 'Ready to confirm',
    blurb: 'Contributors agree. Confirm in bulk.',
  },
  {
    bucket: 'single',
    title: 'One vote only',
    blurb: 'Provisional. Nobody has corroborated these yet - confirm, or leave them to gather a second opinion.',
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

function ClaimRow({
  claim,
  isWinner,
  onChoose,
  busy,
}: {
  claim: ConsensusTallyEntry;
  isWinner: boolean;
  onChoose?: () => void;
  busy: boolean;
}) {
  return (
    <li className={`claim${isWinner ? ' claim-winner' : ''}`}>
      <div className="claim-votes">
        {claim.count} {claim.count === 1 ? 'vote' : 'votes'}
      </div>
      <div className="claim-outcome">
        <OutcomeSummary outcome={claim.outcome} />
        {claim.voterLabels.length > 0 ? <div className="claim-voters">{claim.voterLabels.join(', ')}</div> : null}
      </div>
      {onChoose ? (
        <button type="button" className="btn btn-secondary" onClick={onChoose} disabled={busy}>
          Use this
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

  useEffect(() => {
    void load();
  }, [load]);

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
    </section>
  );
}
