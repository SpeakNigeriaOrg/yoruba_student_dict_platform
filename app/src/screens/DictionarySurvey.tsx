// screens/DictionarySurvey.tsx
//
// The curating surface: an overview of the corpus, and the survey it summarises.
//
// ---------------------------------------------------------------------------
// One list, several ways in
// ---------------------------------------------------------------------------
// The overview and the word list are not two screens. Every number on the overview is a
// button that opens the list filtered to exactly the words behind it, because a count you
// cannot open is a count you have to go and reproduce by hand - which is what a curator has
// been doing by running the export scripts and reading their console output.
//
// The filter is therefore the whole state of this screen, and it is one value rather than a
// row of checkboxes: a curator is asking one question at a time ("which words have no
// image?"), and combinations of six independent toggles mostly name populations nobody
// wants.
//
// ---------------------------------------------------------------------------
// What it deliberately does NOT show
// ---------------------------------------------------------------------------
// Anything scoped to the reader. This screen replaces Browse, whose badges came from the
// per-user flags and so told a curator a word was "not yet recorded" when three volunteers
// had recorded it. Everything here is a fact about the corpus.

import { useEffect, useMemo, useState } from 'react';
import { searchVocab, type Vocab } from '@yoruba-student-dict-platform/shared';
import { getDictionary, type DictionaryOverview, type SurveyWord } from '../api.js';
import { AxisState, BlockerMarks, CitationMark, GAME_BLOCKER_LABEL, SpeakerCoverage, WIKTIONARY_BLOCKER_LABEL } from './StateMarks.js';

/** A named question over the corpus. The overview's numbers and the list's filter are the
 * same set of predicates, so a count and the list it opens can never disagree. */
interface Lens {
  key: string;
  label: string;
  test: (w: SurveyWord) => boolean;
}

const LENSES: Lens[] = [
  { key: 'all', label: 'Every word', test: () => true },
  { key: 'entry:golden', label: 'Entry decided', test: (w) => w.entry === 'golden' },
  { key: 'entry:provisional', label: 'Entry proposed, undecided', test: (w) => w.entry === 'provisional' },
  { key: 'entry:none', label: 'Entry untouched', test: (w) => w.entry === 'none' },
  { key: 'etymology:golden', label: 'Etymology decided', test: (w) => w.etymology === 'golden' },
  { key: 'etymology:provisional', label: 'Etymology proposed, undecided', test: (w) => w.etymology === 'provisional' },
  { key: 'etymology:none', label: 'Etymology untouched', test: (w) => w.etymology === 'none' },
  { key: 'citation:cited', label: 'Cited', test: (w) => w.citation === 'cited' },
  { key: 'citation:exempt', label: 'Exempt from citation', test: (w) => w.citation === 'exempt' },
  { key: 'citation:uncited', label: 'Uncited', test: (w) => w.citation === 'uncited' },
  { key: 'audio:0', label: 'No usable recording', test: (w) => w.speakerCount === 0 },
  { key: 'audio:1', label: 'One speaker', test: (w) => w.speakerCount === 1 },
  { key: 'audio:2', label: 'Two speakers', test: (w) => w.speakerCount === 2 },
  { key: 'audio:3', label: 'Three or more speakers', test: (w) => w.speakerCount >= 3 },
  { key: 'audio:stale', label: 'Has stale recordings', test: (w) => w.divergedSpeakerCount > 0 },
  { key: 'image:none', label: 'No image', test: (w) => w.imageCount === 0 },
  { key: 'examples:any', label: 'Has examples', test: (w) => w.exampleCount > 0 },
  { key: 'game:ready', label: 'Ready for the game', test: (w) => w.gameBlockers.length === 0 },
  { key: 'game:blocked', label: 'Blocked from the game', test: (w) => w.gameBlockers.length > 0 },
  { key: 'wik:ready', label: 'Ready for Wiktionary', test: (w) => w.wiktionaryBlockers.length === 0 },
  { key: 'wik:blocked', label: 'Blocked from Wiktionary', test: (w) => w.wiktionaryBlockers.length > 0 },
  ...(['no_matching_recording', 'only_stale_recordings', 'no_speaker_covers_syllables', 'no_image'] as const).map(
    (b) => ({ key: `gameblocker:${b}`, label: GAME_BLOCKER_LABEL[b], test: (w: SurveyWord) => w.gameBlockers.includes(b) }),
  ),
  ...(['no_citation_row', 'no_part_of_speech', 'no_english_gloss'] as const).map((b) => ({
    key: `wikblocker:${b}`,
    label: WIKTIONARY_BLOCKER_LABEL[b],
    test: (w: SurveyWord) => w.wiktionaryBlockers.includes(b),
  })),
];

const LENS_BY_KEY = new Map(LENSES.map((l) => [l.key, l]));

type SortKey = 'wordId' | 'displayText' | 'speakers' | 'examples' | 'blockers';

export interface DictionarySurveyProps {
  /** 'overview' and 'words' are the same data; the tab decides whether the summary or the
   * list leads. Both are always reachable from the other. */
  tab: 'overview' | 'words';
  onTabChange: (tab: 'overview' | 'words') => void;
  onOpenDossier: (wordId: string) => void;
  /** Opens the word for review - contributing, not curating. Kept distinct from the dossier
   * on purpose: they are the two levels, and this screen is the one place both are offered. */
  onOpenWord: (wordId: string) => void;
}

export function DictionarySurvey({ tab, onTabChange, onOpenDossier, onOpenWord }: DictionarySurveyProps) {
  const [words, setWords] = useState<SurveyWord[] | null>(null);
  const [overview, setOverview] = useState<DictionaryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lensKey, setLensKey] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'wordId', desc: false });

  useEffect(() => {
    let cancelled = false;
    getDictionary()
      .then((result) => {
        if (cancelled) return;
        setWords(result.words);
        setOverview(result.overview);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The shared search engine, same as Browse used, so a curator's muscle memory for
  // tone-insensitive lookup carries over.
  const vocab = useMemo<Vocab>(() => {
    const v: Vocab = {};
    for (const w of words ?? []) {
      v[w.wordId] = {
        displayText: w.displayText,
        syllables: w.syllables,
        ...(w.definition !== null ? { definition: w.definition } : {}),
        ...(w.entryType === 'phrase' ? { type: 'phrase' as const } : {}),
      };
    }
    return v;
  }, [words]);

  const shown = useMemo(() => {
    if (!words) return [];
    const lens = LENS_BY_KEY.get(lensKey) ?? LENSES[0];
    let rows = words.filter(lens.test);
    if (query.trim()) {
      const byId = new Map(rows.map((r) => [r.wordId, r]));
      rows = searchVocab(vocab, query, words.length)
        .map((r) => byId.get(r.wordId))
        .filter((r): r is SurveyWord => Boolean(r));
    }
    const direction = sort.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case 'displayText':
          return direction * a.displayText.localeCompare(b.displayText);
        case 'speakers':
          return direction * (a.speakerCount - b.speakerCount);
        case 'examples':
          return direction * (a.exampleCount - b.exampleCount);
        case 'blockers':
          return direction * (a.gameBlockers.length - b.gameBlockers.length);
        default:
          return direction * a.wordId.localeCompare(b.wordId);
      }
    });
  }, [words, lensKey, query, sort, vocab]);

  function openLens(key: string) {
    setLensKey(key);
    setQuery('');
    onTabChange('words');
  }

  if (error)
    return (
      <p role="alert" className="error-banner">
        Couldn't load the dictionary: {error}
      </p>
    );
  if (!words || !overview) return <p>Loading the dictionary...</p>;

  return (
    <>
      {tab === 'overview' ? (
        <Overview overview={overview} onOpenLens={openLens} />
      ) : (
        <WordTable
          rows={shown}
          total={words.length}
          lensKey={lensKey}
          query={query}
          sort={sort}
          onLensChange={setLensKey}
          onQueryChange={setQuery}
          onSortChange={setSort}
          onOpenDossier={onOpenDossier}
          onOpenWord={onOpenWord}
        />
      )}
    </>
  );
}

function StatRow({ label, value, lens, onOpenLens }: { label: string; value: number; lens?: string; onOpenLens: (k: string) => void }) {
  return (
    <button
      type="button"
      className="stat-row"
      disabled={!lens || value === 0}
      onClick={() => lens && onOpenLens(lens)}
    >
      <span>{label}</span>
      <span className="stat-value">{value}</span>
    </button>
  );
}

function Overview({ overview, onOpenLens }: { overview: DictionaryOverview; onOpenLens: (key: string) => void }) {
  return (
    <section aria-label="Dictionary overview">
      <p>
        <span className="stat-headline">{overview.totalWords}</span> entries in the dictionary. Every number below opens
        the words behind it.
      </p>
      <div className="stat-grid">
        <div className="stat-card">
          <h3>Entry axis</h3>
          <StatRow label="Decided" value={overview.entry.golden} lens="entry:golden" onOpenLens={onOpenLens} />
          <StatRow label="Proposed, undecided" value={overview.entry.provisional} lens="entry:provisional" onOpenLens={onOpenLens} />
          <StatRow label="Untouched" value={overview.entry.none} lens="entry:none" onOpenLens={onOpenLens} />
        </div>
        <div className="stat-card">
          <h3>Etymology axis</h3>
          <StatRow label="Decided" value={overview.etymology.golden} lens="etymology:golden" onOpenLens={onOpenLens} />
          <StatRow label="Proposed, undecided" value={overview.etymology.provisional} lens="etymology:provisional" onOpenLens={onOpenLens} />
          <StatRow label="Untouched" value={overview.etymology.none} lens="etymology:none" onOpenLens={onOpenLens} />
        </div>
        <div className="stat-card">
          <h3>Upstream</h3>
          <StatRow label="Cited" value={overview.citation.cited} lens="citation:cited" onOpenLens={onOpenLens} />
          <StatRow label="Exempt (no upstream entry)" value={overview.citation.exempt} lens="citation:exempt" onOpenLens={onOpenLens} />
          {/* Named, not just counted. The drift report has always given this as a bare
              number, which is the defect the exempt list was fixed for once already. */}
          <StatRow label="Uncited" value={overview.citation.uncited} lens="citation:uncited" onOpenLens={onOpenLens} />
        </div>
        <div className="stat-card">
          <h3>Recording coverage</h3>
          <StatRow label="No usable recording" value={overview.audioCoverage.none} lens="audio:0" onOpenLens={onOpenLens} />
          <StatRow label="One speaker" value={overview.audioCoverage.one} lens="audio:1" onOpenLens={onOpenLens} />
          <StatRow label="Two speakers" value={overview.audioCoverage.two} lens="audio:2" onOpenLens={onOpenLens} />
          <StatRow label="Three or more" value={overview.audioCoverage.threeOrMore} lens="audio:3" onOpenLens={onOpenLens} />
          <StatRow label="Has stale recordings" value={overview.wordsWithStaleAudio} lens="audio:stale" onOpenLens={onOpenLens} />
        </div>
        <div className="stat-card">
          <h3>Ready for the game</h3>
          <StatRow label="Nothing blocking" value={overview.gameReady} lens="game:ready" onOpenLens={onOpenLens} />
          {(Object.keys(GAME_BLOCKER_LABEL) as Array<keyof typeof GAME_BLOCKER_LABEL>).map((b) => (
            <StatRow
              key={b}
              label={GAME_BLOCKER_LABEL[b]}
              value={overview.gameBlockers[b]}
              lens={`gameblocker:${b}`}
              onOpenLens={onOpenLens}
            />
          ))}
        </div>
        <div className="stat-card">
          <h3>Ready for Wiktionary</h3>
          <StatRow label="Nothing blocking" value={overview.wiktionaryReady} lens="wik:ready" onOpenLens={onOpenLens} />
          {(Object.keys(WIKTIONARY_BLOCKER_LABEL) as Array<keyof typeof WIKTIONARY_BLOCKER_LABEL>).map((b) => (
            <StatRow
              key={b}
              label={WIKTIONARY_BLOCKER_LABEL[b]}
              value={overview.wiktionaryBlockers[b]}
              lens={`wikblocker:${b}`}
              onOpenLens={onOpenLens}
            />
          ))}
        </div>
      </div>
      <p className="field-note">
        The two readiness cards apply the same rules the publish and export scripts apply, so a word counted ready here
        is a word those scripts will take.
      </p>
    </section>
  );
}

function WordTable({
  rows,
  total,
  lensKey,
  query,
  sort,
  onLensChange,
  onQueryChange,
  onSortChange,
  onOpenDossier,
  onOpenWord,
}: {
  rows: SurveyWord[];
  total: number;
  lensKey: string;
  query: string;
  sort: { key: SortKey; desc: boolean };
  onLensChange: (key: string) => void;
  onQueryChange: (q: string) => void;
  onSortChange: (s: { key: SortKey; desc: boolean }) => void;
  onOpenDossier: (wordId: string) => void;
  onOpenWord: (wordId: string) => void;
}) {
  function header(key: SortKey, label: string) {
    const active = sort.key === key;
    return (
      <th aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
        <button type="button" onClick={() => onSortChange({ key, desc: active ? !sort.desc : false })}>
          {label}
          {active ? (sort.desc ? ' ↓' : ' ↑') : ''}
        </button>
      </th>
    );
  }

  return (
    <section aria-label="Word survey">
      <div className="field-inline">
        <label htmlFor="survey-lens">Showing</label>{' '}
        <select id="survey-lens" value={lensKey} onChange={(e) => onLensChange(e.target.value)} aria-label="Filter">
          {LENSES.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by spelling, word_id or meaning - tone marks optional..."
          aria-label="Search the survey"
        />
      </div>
      <p className="field-note" aria-label="Survey count">
        {rows.length} of {total} entries
      </p>

      {rows.length === 0 ? (
        <p>No words match.</p>
      ) : (
        <div className="table-scroll">
          <table className="survey">
            <thead>
              <tr>
                {header('displayText', 'Word')}
                <th>Entry</th>
                <th>Etymology</th>
                <th>Upstream</th>
                {header('speakers', 'Speakers')}
                <th>Images</th>
                {header('examples', 'Examples')}
                {header('blockers', 'Game')}
                <th>Wiktionary</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.wordId}>
                  <td className="word-cell">
                    <button type="button" onClick={() => onOpenDossier(w.wordId)}>
                      {w.displayText}
                    </button>
                    <br />
                    <span className="word-id">{w.wordId}</span>
                  </td>
                  <td>
                    <AxisState axis="entry" state={w.entry} />
                  </td>
                  <td>
                    <AxisState axis="etym" state={w.etymology} />
                  </td>
                  <td>
                    <CitationMark state={w.citation} reason={w.exemptReason} />
                  </td>
                  <td>
                    <SpeakerCoverage
                      speakerCount={w.speakerCount}
                      fullyCoveredSpeakerCount={w.fullyCoveredSpeakerCount}
                      divergedSpeakerCount={w.divergedSpeakerCount}
                    />
                  </td>
                  <td>
                    <span className={`figure${w.imageCount === 0 ? ' zero' : ''}`}>{w.imageCount}</span>
                  </td>
                  <td>
                    <span className={`figure${w.exampleCount === 0 ? ' zero' : ''}`}>{w.exampleCount}</span>
                    {w.staleExampleCount > 0 ? <span className="figure warn"> ({w.staleExampleCount} stale)</span> : null}
                  </td>
                  <td>
                    <BlockerMarks labels={w.gameBlockers.map((b) => GAME_BLOCKER_LABEL[b])} />
                  </td>
                  <td>
                    <BlockerMarks labels={w.wiktionaryBlockers.map((b) => WIKTIONARY_BLOCKER_LABEL[b])} />
                  </td>
                  <td>
                    {/* Both levels, named for what they are. Reviewing is contributing;
                        the dossier is the curator's read of the same word. */}
                    <button type="button" className="btn btn-secondary" onClick={() => onOpenWord(w.wordId)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
