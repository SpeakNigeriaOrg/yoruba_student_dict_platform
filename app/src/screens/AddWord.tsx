// screens/AddWord.tsx
//
// Add a brand-new word or phrase - curator-gated (POST /api/words,
// POST /api/phrases), mirroring the old tool's add_word.html/.js: search
// Kaikki (word) or existing vocab (phrase components), a duplicate-check
// warning that never blocks, and an editable syllables field. New words
// are deliberately "unverified" on every axis at creation - vetting is a
// separate, later step via the review screens.
//
// ---------------------------------------------------------------------------
// Adding a word IS choosing an etymology
// ---------------------------------------------------------------------------
// This screen already searched Kaikki and had a human pick a result, and a
// result is one Wiktionary etymology. It then threw that away and posted only
// the spelling - so the word's identity had to be guessed back later by matching
// forms, which cannot work: `kọ́` is three etymologies sharing one spelling.
//
// So the pick is now the citation, captured at the one moment it is unambiguous
// and free. Everything downstream - the student definition seeded from the
// etymology's glosses, drift detection, compounds referencing one etymology -
// follows from having it.
//
// The off-path branch is deliberately secondary rather than absent. Some real
// words have no Wiktionary entry at all (loanwords, calendar names, local
// compounds), and refusing them outright would only pressure someone into citing
// an unrelated etymology to get past the form, which is worse than an honest
// exemption. The preferred route - have a curator add it upstream first - is
// stated where the choice is made.

import { useEffect, useRef, useState } from 'react';
import type { KaikkiSearchResult, VocabSearchResult } from '@yoruba-student-dict-platform/shared';
import { orthographyInsensitiveForm, syllabifyWord } from '@yoruba-student-dict-platform/shared';
import { createPhrase, createWord, getDuplicateCheck, searchKaikki, searchVocab, type DuplicateMatch } from '../api.js';
import { SearchBox } from './SearchBox.js';

type Tab = 'word' | 'phrase';

/** The spelling/concept check - kept, and deliberately SECONDARY now.
 *
 * It used to be the only duplicate signal on this screen, which is how `jẹun` could be offered as new
 * while `jeun_eat` already cited the very etymology on offer: "identical spelling" is a resemblance,
 * and the question is identity. The etymology verdict above answers that exactly.
 *
 * It survives because identity is structurally SILENT for two populations: the pre-0014 words with no
 * citation row, and exempt words (a real word with no Wiktionary entry). For those, a shared spelling
 * is the best signal there is. Its concept path also still catches a same-meaning/different-etymology
 * overlap, which entry_id equality cannot see. Still fail-open - it warns, never blocks.
 */
function DuplicateWarning({ matches }: { matches: DuplicateMatch[] | null }) {
  if (matches === null) return null;
  if (matches.length === 0) return <p className="field-note">No similar spellings or concepts found.</p>;
  return (
    <div role="alert" aria-label="Duplicate warning" className="warning-banner">
      <p>Also worth checking - similar spellings and concepts:</p>
      <ul>
        {matches.map((m) => (
          <li key={m.wordId}>
            {m.wordId} ({m.displayText}) - {m.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Whether this etymology is already someone's identity - the authoritative answer, on the row.
 *
 * Shown BEFORE picking, which is the actual fix. The old flow let a curator pick, fill in the form and
 * only then read a spelling warning; the answer was available at search time all along.
 *
 * Silent when the etymology is free. A green "available" badge on all fifteen rows would be a
 * reassurance on every line, and a signal that fires constantly is one people stop reading - which is
 * precisely how the previous warning came to be ignored. */
function ClaimBadge({ result }: { result: KaikkiSearchResult }) {
  const claim = result.claim;
  // undefined means nobody looked (a caller that does not enrich). Saying nothing is right; saying
  // "available" would be a claim we have not checked.
  if (claim === undefined) return null;

  if (claim?.status === 'in_dictionary') {
    return (
      <>
        {' '}
        <span className="badge claimed">already in the dictionary</span>{' '}
        <span className="field-note">
          as {claim.wordId} ({claim.displayText})
        </span>
      </>
    );
  }

  if (claim?.status === 'requested') {
    return (
      <>
        {' '}
        <span className="badge">requested, not added yet</span>{' '}
        <span className="field-note">planned as {claim.wordId}</span>
      </>
    );
  }

  const spellingMatches = result.spellingMatches ?? [];
  if (spellingMatches.length > 0) {
    return (
      <>
        {' '}
        <span className="badge not-started">same spelling as {spellingMatches.map((m) => m.wordId).join(', ')}</span>{' '}
        <span className="field-note">a different etymology, or a word we cannot compare by id</span>
      </>
    );
  }

  return null;
}

/** How an etymology reads in the result list and in the confirmation banner.
 * The etymology number is shown because it is the only thing distinguishing the
 * three `kọ́` results from each other at a glance. */
function EtymologyLabel({ result }: { result: KaikkiSearchResult }) {
  return (
    <>
      <strong>{result.form}</strong> ({result.pos}
      {result.etymologyNumber ? `, etymology ${result.etymologyNumber}` : ''}) - {result.glosses.join('; ')}
    </>
  );
}

/** A word_id hint from the etymology's primary gloss, so the field arrives filled
 * rather than blank. Still editable: the hint is a human-readable disambiguator
 * in the id, and the first gloss is only a good first guess at one. */
function hintFromGloss(gloss: string | undefined): string {
  if (!gloss) return '';
  return gloss
    .split(/[,;(]/)[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function WordTab({ onOpenWord }: { onOpenWord?: (wordId: string) => void }) {
  const [selected, setSelected] = useState<KaikkiSearchResult | null>(null);
  const [selectedForm, setSelectedForm] = useState('');
  const [syllablesText, setSyllablesText] = useState('');
  const [definitionText, setDefinitionText] = useState('');
  const [hint, setHint] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** The off-path branch: a real word with no Wiktionary entry. Separate state
   * rather than a null selection, so the two paths cannot be half-entered. */
  const [offPath, setOffPath] = useState(false);
  const [exemptReason, setExemptReason] = useState('');
  const detailsRef = useRef<HTMLDivElement | null>(null);

  // Clicking Select used to change nothing visible: the confirmation sat below a long result list, so
  // the curator had to trust it happened and then scroll to check. Move to it instead.
  useEffect(() => {
    if (!selected) return;
    // Optional call - jsdom does not implement scrollIntoView, and an unguarded one throws in every
    // test that clicks Select.
    detailsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    detailsRef.current?.focus({ preventScroll: true });
  }, [selected?.entryId]);

  useEffect(() => {
    if (!selectedForm) {
      setDuplicates(null);
      return;
    }
    getDuplicateCheck(selectedForm, selected?.altOfTargets ?? [])
      .then(setDuplicates)
      .catch(() => setDuplicates(null));
  }, [selectedForm, selected]);

  /** Setting the spelling and splitting it are ONE action, never two.
   *
   * They were written as three separate copies - the initial pick, the off-path spelling field, and the
   * "choose a spelling" radio - and the radio only set the spelling. So switching spelling left the
   * PREVIOUS form's syllables in the box, and nothing downstream would ever notice: words.ts checks
   * only that syllables is a non-empty array of strings, so the mismatched pair lands in golden_record
   * as the word's canonical split. From there the tone grid teaches a volunteer to record exactly that
   * split, and publish compares recorded_syllables to golden_record.syllables with EXACT equality - so
   * the word either ships with a wrong split or can never be recorded in a way that matches.
   *
   * The syllables field stays editable on purpose (an automatic split can be wrong - see the nasal
   * cases in shared/src/syllabify.ts), but an edit made for one spelling says nothing about a different
   * one, so changing spelling correctly discards it. */
  function chooseSpelling(form: string) {
    setSelectedForm(form);
    setSyllablesText(syllabifyWord(form).join(','));
  }

  function pickResult(result: KaikkiSearchResult) {
    setSelected(result);
    chooseSpelling(result.standardForms[0] ?? result.form);
    // Seeded from the etymology's primary gloss, not authored from scratch: the
    // student definition is a simplification OF this etymology's meaning.
    setDefinitionText(result.glosses[0] ?? '');
    setHint(hintFromGloss(result.glosses[0]));
  }

  function startOffPath() {
    setOffPath(true);
    setSelected(null);
    setSelectedForm('');
    setSyllablesText('');
    setDefinitionText('');
    setHint('');
  }

  function backToSearch() {
    setOffPath(false);
    setExemptReason('');
    setSelectedForm('');
    setSyllablesText('');
    setDefinitionText('');
    setHint('');
  }

  const wordIdPreview = selectedForm && hint ? `${orthographyInsensitiveForm(selectedForm).replace(/ /g, '_')}_${hint}` : '';
  const citable = offPath ? Boolean(exemptReason.trim()) : Boolean(selected?.entryId);

  async function submit() {
    if (!wordIdPreview) {
      setStatus(
        offPath ? 'Enter a spelling and a word_id hint first.' : 'Pick a Kaikki result and enter a word_id hint first.',
      );
      return;
    }
    if (offPath && !exemptReason.trim()) {
      setStatus('Say why this word has no Wiktionary entry - a blank cannot be told apart from unfinished work.');
      return;
    }
    if (!offPath && !selected?.entryId) {
      // Only reachable against a corpus ingested before entry ids existed.
      setStatus('That Kaikki record carries no etymology id - re-ingest the corpus before citing it.');
      return;
    }
    try {
      await createWord({
        wordId: wordIdPreview,
        displayText: selectedForm,
        syllables: syllablesText.split(',').map((s) => s.trim()).filter(Boolean),
        definition: definitionText.trim() || null,
        citation: offPath ? { exemptReason: exemptReason.trim() } : { entryId: selected!.entryId! },
      });
      setStatus(`Added ${wordIdPreview} to vocabulary.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  const showDetails = offPath || selected !== null;

  return (
    <div aria-label="Add word tab">
      {offPath ? (
        <div className="warning-banner" aria-label="Off-path warning">
          <p>
            <strong>This word has no Wiktionary entry.</strong> The preferred route is to ask a curator to add it to
            Wiktionary first, then come back and cite it - a cited word can be checked against upstream forever, and this
            one cannot.
          </p>
          <button type="button" className="btn btn-secondary" onClick={backToSearch}>
            Back to search
          </button>
        </div>
      ) : (
        <>
          <p className="field-note">
            A word enters the dictionary as one Wiktionary etymology. Search for it and pick the etymology you mean - the
            same spelling often has several.
          </p>
          <SearchBox
            search={searchKaikki}
            renderResult={(r) => (
              <>
                <EtymologyLabel result={r} />
                <ClaimBadge result={r} />
              </>
            )}
            onSelect={pickResult}
            selectLabel="Select"
            placeholder="Search Kaikki by spelling or meaning..."
            resultsAriaLabel="Kaikki search results"
            isSelected={(r) => r.entryId !== null && r.entryId === selected?.entryId}
            // An etymology already in the dictionary cannot be added again - the server refuses it, and
            // 0017 makes it impossible - so offer the useful action instead of a button that leads to a
            // rejection after the form is filled in. A REQUESTED one keeps Select: adding it is exactly
            // what fulfilling the request means, and doing so now closes the request.
            renderAction={(r) =>
              r.claim?.status === 'in_dictionary' && onOpenWord ? (
                <button type="button" className="btn btn-secondary" onClick={() => onOpenWord(r.claim!.wordId)}>
                  Open {r.claim.wordId}
                </button>
              ) : null
            }
          />
        </>
      )}

      {showDetails ? (
        <div ref={detailsRef} tabIndex={-1} aria-label="Selected etymology">
          {selected ? (
            // aria-live rather than role="status": this screen already has one status region for the
            // submit banner, and a second would make getByRole('status') ambiguous.
            <p aria-label="Cited etymology" aria-live="polite" className="status-banner">
              Citing: <EtymologyLabel result={selected} />
            </p>
          ) : null}
          {offPath ? (
            <div className="field">
              <label htmlFor="word-spelling-field">Spelling</label>
              <input
                id="word-spelling-field"
                type="text"
                value={selectedForm}
                onChange={(e) => chooseSpelling(e.target.value)}
              />
            </div>
          ) : null}

          {selected && selected.standardForms.length > 1 ? (
            <div className="field">
              <p>Choose a spelling:</p>
              {selected.standardForms.map((form) => (
                <div key={form} className="field-inline">
                  <label>
                    <input
                      type="radio"
                      name="spelling-form"
                      checked={selectedForm === form}
                      onChange={() => chooseSpelling(form)}
                    />
                    {form}
                  </label>
                </div>
              ))}
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="word-syllables-field">Syllables (comma-separated)</label>
            <input
              id="word-syllables-field"
              type="text"
              value={syllablesText}
              onChange={(e) => setSyllablesText(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="word-definition-field">Student definition</label>
            {selected && selected.glosses.length > 0 ? (
              <p className="field-note" aria-label="Upstream glosses">
                Wiktionary says: {selected.glosses.join('; ')}
              </p>
            ) : null}
            <textarea
              id="word-definition-field"
              value={definitionText}
              onChange={(e) => setDefinitionText(e.target.value)}
            />
            <p className="field-note">
              Plain wording a student will understand. Simplifying Wiktionary's wording is expected - it is a
              simplification, not a correction.
            </p>
          </div>

          {offPath ? (
            <div className="field">
              <label htmlFor="word-exempt-field">Why is this word not in Wiktionary?</label>
              <input
                id="word-exempt-field"
                type="text"
                value={exemptReason}
                onChange={(e) => setExemptReason(e.target.value)}
                placeholder="e.g. recent loanword; traditional calendar name"
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="word-hint-field">Word ID hint (English meaning, e.g. "hand")</label>
            <input id="word-hint-field" type="text" value={hint} onChange={(e) => setHint(e.target.value.replace(/\s+/g, '_'))} />
          </div>

          <p>
            Word ID: <strong>{wordIdPreview || '(enter a hint)'}</strong>
          </p>

          <DuplicateWarning matches={duplicates} />

          <button type="button" className="btn btn-primary" onClick={submit} disabled={!citable}>
            Add to vocabulary
          </button>
        </div>
      ) : null}

      {!offPath ? (
        <p className="field-note">
          <button type="button" className="btn btn-secondary" onClick={startOffPath}>
            This word isn't in Wiktionary
          </button>
        </p>
      ) : null}

      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </div>
  );
}

function PhraseTab() {
  const [components, setComponents] = useState<VocabSearchResult[]>([]);
  const [hint, setHint] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const displayText = components.map((c) => c.displayText).join(' ');
  const syllables = components.flatMap((c) => c.syllables);
  const wordIdPreview = displayText && hint ? `${orthographyInsensitiveForm(displayText).replace(/ /g, '_')}_${hint}` : '';

  useEffect(() => {
    if (!displayText) {
      setDuplicates(null);
      return;
    }
    getDuplicateCheck(displayText, []).then(setDuplicates).catch(() => setDuplicates(null));
  }, [displayText]);

  function addComponent(result: VocabSearchResult) {
    setComponents((prev) => (prev.some((c) => c.wordId === result.wordId) ? prev : [...prev, result]));
  }

  function removeComponent(wordId: string) {
    setComponents((prev) => prev.filter((c) => c.wordId !== wordId));
  }

  async function submit() {
    if (components.length === 0) {
      setStatus('A phrase needs at least one component.');
      return;
    }
    if (!wordIdPreview) {
      setStatus('Enter a word_id hint first.');
      return;
    }
    try {
      await createPhrase({
        wordId: wordIdPreview,
        displayText,
        syllables,
        components: components.map((c) => c.wordId),
      });
      setStatus(`Added phrase ${wordIdPreview} to vocabulary.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div aria-label="Add phrase tab">
      {components.length === 0 ? (
        <p>No components picked yet.</p>
      ) : (
        <ul aria-label="Phrase components" className="plain-list">
          {components.map((c) => (
            <li key={c.wordId} className="search-result-row">
              {/* The word and its meaning, not the word_id. Picking a word_id IS picking one
                  etymology - that is the point - but the id is a key, and leading with it made the
                  list unreadable to anyone who does not already know our naming scheme. The meaning
                  is what tells two etymologies of one spelling apart, which is the actual choice
                  being made here. */}
              <span className="result-text">
                <strong>{c.displayText}</strong>
                {c.definition ? ` — ${c.definition}` : ''}
              </span>
              <button type="button" className="btn btn-danger" onClick={() => removeComponent(c.wordId)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <SearchBox
        search={searchVocab}
        renderResult={(r) => (
          <>
            <strong>{r.displayText}</strong>
            {r.definition ? ` — ${r.definition}` : ''}
          </>
        )}
        onSelect={addComponent}
        selectLabel="Add"
        placeholder="Search existing vocabulary..."
        resultsAriaLabel="Vocab search results"
      />

      <p>
        Display text: <strong>{displayText || '(pick components)'}</strong>
        <br />
        Syllables: <strong>{syllables.join(' · ')}</strong>
      </p>

      <div className="field">
        <label htmlFor="phrase-hint-field">Word ID hint</label>
        <input id="phrase-hint-field" type="text" value={hint} onChange={(e) => setHint(e.target.value.replace(/\s+/g, '_'))} />
      </div>

      <p>
        Word ID: <strong>{wordIdPreview || '(enter a hint)'}</strong>
      </p>

      <DuplicateWarning matches={duplicates} />

      <button type="button" className="btn btn-primary" onClick={submit}>
        Add phrase to vocabulary
      </button>
      {status ? <p role="status" className="status-banner">{status}</p> : null}
    </div>
  );
}

export interface AddWordProps {
  /** Navigates to an existing word - used when a search result turns out to already BE a word, where
   * "go look at it" is the only useful action. Optional so a test can render this screen alone. */
  onOpenWord?: (wordId: string) => void;
}

export function AddWord({ onOpenWord }: AddWordProps = {}) {
  const [tab, setTab] = useState<Tab>('word');

  return (
    <section aria-label="Add a word" className="card">
      <nav aria-label="Add word tabs" className="axis-tabs">
        <button type="button" aria-current={tab === 'word' ? 'page' : undefined} onClick={() => setTab('word')}>
          Word
        </button>
        <button type="button" aria-current={tab === 'phrase' ? 'page' : undefined} onClick={() => setTab('phrase')}>
          Phrase
        </button>
      </nav>
      {tab === 'word' ? <WordTab onOpenWord={onOpenWord} /> : <PhraseTab />}
    </section>
  );
}
