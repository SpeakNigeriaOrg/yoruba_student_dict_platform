// screens/StateMarks.tsx
//
// The curator level's visual vocabulary, in one place so the survey, the overview and the
// dossier cannot drift into three dialects of it.
//
// ---------------------------------------------------------------------------
// Why this is not AxisStatusBadges
// ---------------------------------------------------------------------------
// That component answers a contributor's question - is this off my list - and two colours
// are enough for it. A curator's question has a third answer, and it is the one that was
// invisible: somebody has offered an opinion and nobody has ratified it. A word in that
// state is not "done" and not "untouched"; it is waiting on a decision, which is the
// curator's own job.
//
// So: solid = the record says this, hollow = somebody thinks this, grey = nobody has looked.
// Hollow rather than a second shade of green, so the distinction survives greyscale.
//
// Counts are rendered as counts. "3 speakers" wrapped in a badge loses the 3, and the 3 is
// the part someone planning a recording session can act on.

import type { CitationState, GameBlocker, GlobalAxisState, WiktionaryBlocker } from '../api.js';

const AXIS_STATE_LABEL: Record<GlobalAxisState, string> = {
  golden: 'decided',
  provisional: 'proposed',
  none: 'untouched',
};

export function AxisState({ axis, state }: { axis: string; state: GlobalAxisState }) {
  return (
    <span className={`state ${state}`} title={`${axis}: ${AXIS_STATE_LABEL[state]}`}>
      {axis} · {AXIS_STATE_LABEL[state]}
    </span>
  );
}

const CITATION_LABEL: Record<CitationState, string> = {
  cited: 'cited',
  exempt: 'exempt',
  uncited: 'uncited',
};

/** `exempt` is a decision on record - someone established there is no upstream entry and
 * said why - so it reads as settled, not as a gap. `uncited` is the absence of any answer,
 * which is why it is amber rather than grey: it is outstanding work, not a blank. */
export function CitationMark({ state, reason }: { state: CitationState; reason?: string | null }) {
  const weight = state === 'cited' ? 'golden' : state === 'exempt' ? 'none' : 'provisional';
  return (
    <span className={`state ${weight}`} title={reason ?? undefined}>
      {CITATION_LABEL[state]}
    </span>
  );
}

/** Speakers whose recordings publish would accept, and - separately, in amber - those whose
 * recordings exist but no longer match the word. Two numbers, because they call for
 * different work: one is a session to schedule, the other is a re-record by someone who has
 * already done it once. */
export function SpeakerCoverage({
  speakerCount,
  fullyCoveredSpeakerCount,
  divergedSpeakerCount,
}: {
  speakerCount: number;
  fullyCoveredSpeakerCount: number;
  divergedSpeakerCount: number;
}) {
  return (
    <>
      <span className={`figure${speakerCount === 0 ? ' zero' : ''}`} title="speakers whose recording still matches the word">
        {speakerCount}
        {fullyCoveredSpeakerCount < speakerCount ? (
          <span title="of those, how many recorded every syllable"> ({fullyCoveredSpeakerCount} full)</span>
        ) : null}
      </span>
      {divergedSpeakerCount > 0 ? (
        <>
          {' '}
          <span className="figure warn" title="speakers whose recordings no longer match, so publish drops them">
            +{divergedSpeakerCount} stale
          </span>
        </>
      ) : null}
    </>
  );
}

export const GAME_BLOCKER_LABEL: Record<GameBlocker, string> = {
  no_matching_recording: 'not recorded',
  only_stale_recordings: 'recordings stale',
  no_speaker_covers_syllables: 'syllables incomplete',
  no_image: 'no image',
};

export const WIKTIONARY_BLOCKER_LABEL: Record<WiktionaryBlocker, string> = {
  no_citation_row: 'no citation',
  no_part_of_speech: 'no part of speech',
  no_english_gloss: 'no gloss',
};

/** Red, because a blocker is a dead end for the action in question rather than a caution to
 * weigh - the same meaning red already carries on the "already claimed" badge. */
export function BlockerMarks({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="state golden">ready</span>;
  return (
    <span className="badge-row">
      {labels.map((l) => (
        <span key={l} className="state blocked">
          {l}
        </span>
      ))}
    </span>
  );
}
