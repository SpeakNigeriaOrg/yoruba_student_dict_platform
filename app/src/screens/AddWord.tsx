// screens/AddWord.tsx
//
// Add a brand-new word or phrase - curator-gated (POST /api/words,
// POST /api/phrases), mirroring the old tool's add_word.html/.js: search
// Kaikki (word) or existing vocab (phrase components), a duplicate-check
// warning that never blocks, and an editable syllables field. New words
// are deliberately "unverified" on every axis at creation - vetting is a
// separate, later step via the review screens.

import { useEffect, useState } from 'react';
import type { KaikkiSearchResult, VocabSearchResult } from '@yoruba-student-dict-platform/shared';
import { orthographyInsensitiveForm, syllabifyWord } from '@yoruba-student-dict-platform/shared';
import { createPhrase, createWord, getDuplicateCheck, searchKaikki, searchVocab, type DuplicateMatch } from '../api.js';
import { SearchBox } from './SearchBox.js';

type Tab = 'word' | 'phrase';

function DuplicateWarning({ matches }: { matches: DuplicateMatch[] | null }) {
  if (matches === null) return null;
  if (matches.length === 0) return <p>No likely duplicates found.</p>;
  return (
    <div role="alert" aria-label="Duplicate warning" className="warning-banner">
      <p>Possible duplicates - review before adding:</p>
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

function WordTab() {
  const [selected, setSelected] = useState<KaikkiSearchResult | null>(null);
  const [selectedForm, setSelectedForm] = useState('');
  const [syllablesText, setSyllablesText] = useState('');
  const [hint, setHint] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedForm) {
      setDuplicates(null);
      return;
    }
    getDuplicateCheck(selectedForm, selected?.altOfTargets ?? [])
      .then(setDuplicates)
      .catch(() => setDuplicates(null));
  }, [selectedForm, selected]);

  function pickResult(result: KaikkiSearchResult) {
    setSelected(result);
    const form = result.standardForms[0] ?? result.form;
    setSelectedForm(form);
    setSyllablesText(syllabifyWord(form).join(','));
  }

  const wordIdPreview = selectedForm && hint ? `${orthographyInsensitiveForm(selectedForm).replace(/ /g, '_')}_${hint}` : '';

  async function submit() {
    if (!wordIdPreview) {
      setStatus('Pick a Kaikki result and enter a word_id hint first.');
      return;
    }
    try {
      await createWord({
        wordId: wordIdPreview,
        displayText: selectedForm,
        syllables: syllablesText.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setStatus(`Added ${wordIdPreview} to vocabulary.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div aria-label="Add word tab">
      <SearchBox
        search={searchKaikki}
        renderResult={(r) => (
          <>
            <strong>{r.form}</strong> ({r.pos}) - {r.glosses.join('; ')}
          </>
        )}
        onSelect={pickResult}
        selectLabel="Select"
        placeholder="Search Kaikki by spelling or meaning..."
        resultsAriaLabel="Kaikki search results"
      />

      {selected ? (
        <>
          {selected.standardForms.length > 1 ? (
            <div className="field">
              <p>Choose a spelling:</p>
              {selected.standardForms.map((form) => (
                <div key={form} className="field-inline">
                  <label>
                    <input type="radio" name="spelling-form" checked={selectedForm === form} onChange={() => setSelectedForm(form)} />
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
            <label htmlFor="word-hint-field">Word ID hint (English meaning, e.g. "hand")</label>
            <input id="word-hint-field" type="text" value={hint} onChange={(e) => setHint(e.target.value.replace(/\s+/g, '_'))} />
          </div>

          <p>
            Word ID: <strong>{wordIdPreview || '(enter a hint)'}</strong>
          </p>

          <DuplicateWarning matches={duplicates} />

          <button type="button" className="btn btn-primary" onClick={submit}>
            Add to vocabulary
          </button>
        </>
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
        <ul aria-label="Phrase components" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {components.map((c) => (
            <li key={c.wordId} className="search-result-row">
              <span className="result-text">
                {c.wordId} ({c.displayText})
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
            <strong>{r.wordId}</strong> - {r.displayText}
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

export function AddWord() {
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
      {tab === 'word' ? <WordTab /> : <PhraseTab />}
    </section>
  );
}
