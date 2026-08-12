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
import { deriveWordId, isMultiWord, orthographyInsensitiveForm, phraseTokens, syllabifyWord } from '@yoruba-student-dict-platform/shared';
import { createPhrase, createWord, getDuplicateCheck, searchKaikki, searchVocab, type DuplicateMatch } from '../api.js';
import { SearchBox } from './SearchBox.js';

type Tab = 'word' | 'phrase';

/** What the Word tab hands to the Phrase tab when the thing being added turns out to be a phrase.
 *
 * Wiktionary has no rule against multi-word entries - 480 of our 6272 - so they arrive in the same
 * search as single words, and adding one on the Word tab produced a row that was really a phrase. The
 * split exists precisely to make a curator say which words a phrase is made of, so a multi-word pick
 * moves the curator there instead of quietly accepting it.
 *
 * `entry` is carried because a multi-word entry usually has an etymology OF ITS OWN, which the phrase
 * can now cite (see createPhrase). `tokens` seeds one component slot per word, so the work arrives
 * half-done rather than as a blank form. */
export interface PhraseHandoff {
  entry?: KaikkiSearchResult;
  displayText: string;
  tokens: string[];
}

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
  // Said first, because it changes what the row's button does. A multi-word entry is a phrase whatever
  // else is true of it, and offering "Select" here would add a phrase as a word.
  if (isMultiWord(result.standardForms[0] ?? result.form)) {
    return (
      <>
        {' '}
        <span className="badge">multi-word - add as a phrase</span>
      </>
    );
  }

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

function WordTab({
  onOpenWord,
  onBuildAsPhrase,
}: {
  onOpenWord?: (wordId: string) => void;
  onBuildAsPhrase: (handoff: PhraseHandoff) => void;
}) {
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
  const [saving, setSaving] = useState(false);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);

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
    const form = result.standardForms[0] ?? result.form;
    // A multi-word entry is a phrase. Rather than refusing, carry it over with its etymology and its
    // words already split out - the curator asked for this entry, and the Phrase tab is where it can
    // actually be recorded.
    if (isMultiWord(form)) {
      onBuildAsPhrase({ entry: result, displayText: form, tokens: phraseTokens(form) });
      return;
    }
    setSelected(result);
    chooseSpelling(form);
    // Seeded from the etymology's primary gloss, not authored from scratch: the
    // student definition is a simplification OF this etymology's meaning.
    setDefinitionText(result.glosses[0] ?? '');
    setHint(hintFromGloss(result.glosses[0]));
  }

  /** Everything the form holds about ONE word, so the three callers that need a clean slate cannot
   * drift apart. `status` is deliberately not cleared - after a successful add it is the confirmation. */
  function resetForm() {
    setSelected(null);
    setSelectedForm('');
    setSyllablesText('');
    setDefinitionText('');
    setHint('');
    setExemptReason('');
    setOffPath(false);
    setDuplicates(null);
  }

  function startOffPath() {
    resetForm();
    setOffPath(true);
  }

  function backToSearch() {
    resetForm();
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
    // The backstop. The pick above already redirects, so reaching here means an off-path spelling was
    // typed with a space in it - and a word row whose spelling is two words is the exact ambiguity the
    // word/phrase split exists to prevent.
    if (isMultiWord(selectedForm)) {
      setStatus('That is more than one word, so it belongs on the Phrase tab - build it from its words there.');
      return;
    }
    if (!offPath && !selected?.entryId) {
      // Only reachable against a corpus ingested before entry ids existed.
      setStatus('That Kaikki record carries no etymology id - re-ingest the corpus before citing it.');
      return;
    }
    // Neither submit had an in-flight guard, so a double click fired two POSTs and the second came back
    // as a confusing 409 for a word that had in fact just been added successfully.
    if (saving) return;
    setSaving(true);
    try {
      await createWord({
        wordId: wordIdPreview,
        displayText: selectedForm,
        syllables: syllablesText.split(',').map((s) => s.trim()).filter(Boolean),
        definition: definitionText.trim() || null,
        citation: offPath ? { exemptReason: exemptReason.trim() } : { entryId: selected!.entryId! },
      });
      setStatus(`Added ${wordIdPreview} to vocabulary.`);
      // Clear the form and go back to the top. Adding words is a repeated action, and the confirmation
      // used to appear at the bottom of a long form with the just-submitted values still in it - so the
      // next word meant scrolling back up past everything, and the enabled button re-POSTed a duplicate.
      resetForm();
      topRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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

/** A component of a phrase, held locally so a just-created word can be added without a round trip.
 *
 * Positional rather than keyed by wordId: a reduplication like `méjì méjì` is one word in two
 * positions, and the position is what distinguishes them. */
interface PhrasePart {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
}

function PhraseTab({ handoff, onConsumeHandoff }: { handoff?: PhraseHandoff; onConsumeHandoff: () => void }) {
  const [components, setComponents] = useState<PhrasePart[]>([]);
  const [hint, setHint] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The etymology of the WHOLE phrase, when it came from a multi-word upstream entry. */
  const [adopted, setAdopted] = useState<KaikkiSearchResult | null>(null);
  /** An upstream word picked as a component that we do not hold yet - pending confirmation of its id. */
  const [pendingPart, setPendingPart] = useState<{ entry: KaikkiSearchResult; wordId: string } | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);

  // Seed from the Word tab. Runs once per handoff: the tab is not unmounted between them, so keying the
  // effect on the spelling is what makes a second hand-off take effect.
  useEffect(() => {
    if (!handoff) return;
    setAdopted(handoff.entry ?? null);
    setComponents([]);
    setHint(hintFromGloss(handoff.entry?.glosses[0]));
    setStatus(
      `${handoff.displayText} is ${handoff.tokens.length} words, so it is a phrase. Add each word below - ` +
        `anything missing from the dictionary can be added from Wiktionary without leaving this tab.`,
    );
    onConsumeHandoff();
  }, [handoff?.displayText]);

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

  /** Appends, deliberately without de-duplicating.
   *
   * It used to refuse a word already in the list, which made a reduplication - `méjì méjì`, `mẹ́ta
   * mẹ́ta`, and several more real corpus entries - impossible to build at all. The server never had that
   * restriction: component_position is the primary key and resyncPhraseFromComponents maps the submitted
   * list through a lookup, so a repeat resolves twice and joins correctly. */
  function addComponent(part: PhrasePart) {
    setComponents((prev) => [...prev, part]);
  }

  function removeComponentAt(index: number) {
    setComponents((prev) => prev.filter((_, i) => i !== index));
  }

  /** An upstream word we do not hold: create it first, with its OWN citation, then use it.
   *
   * This is what makes the multi-word redirect honest. Only 5 of the 480 multi-word corpus entries have
   * every constituent word already in the dictionary, so without this a curator sent here would be
   * stranded 475 times out of 480 - the same dead end resolveOrRequestComponent removed from the
   * etymology axis. A curator may create words, so there is nothing to request: it is created outright.
   *
   * The id is shown and editable before creating because deriveWordId is not injective (4.2% of corpus
   * entries derive an id another entry also derives), and letting the curator settle a collision is
   * better than guessing at a discriminator on their behalf. */
  async function createPendingPart() {
    if (!pendingPart || saving) return;
    const { entry, wordId } = pendingPart;
    const form = entry.standardForms[0] ?? entry.form;
    setSaving(true);
    try {
      const syllablesForPart = syllabifyWord(form);
      await createWord({
        wordId,
        displayText: form,
        syllables: syllablesForPart.length > 0 ? syllablesForPart : [form],
        definition: entry.glosses[0] ?? null,
        citation: { entryId: entry.entryId! },
      });
      addComponent({
        wordId,
        displayText: form,
        syllables: syllablesForPart.length > 0 ? syllablesForPart : [form],
        definition: entry.glosses[0] ?? null,
      });
      setPendingPart(null);
      setStatus(`Added ${wordId} to the dictionary and used it as a component.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setComponents([]);
    setHint('');
    setAdopted(null);
    setPendingPart(null);
    setDuplicates(null);
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
    if (saving) return;
    setSaving(true);
    try {
      await createPhrase({
        wordId: wordIdPreview,
        displayText,
        syllables,
        components: components.map((c) => c.wordId),
        // The phrase's own etymology, when it has one. Upstream has 480 multi-word entries, and their
        // meaning is not the sum of their parts - so recording it is not redundant with the components.
        ...(adopted?.entryId ? { citation: { entryId: adopted.entryId } } : {}),
      });
      setStatus(`Added phrase ${wordIdPreview} to vocabulary.`);
      resetForm();
      topRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div aria-label="Add phrase tab" ref={topRef}>
      {adopted ? (
        <p aria-label="Adopted etymology" className="status-banner">
          Citing the whole phrase as: <EtymologyLabel result={adopted} />
        </p>
      ) : null}

      {components.length === 0 ? (
        <p>No components picked yet.</p>
      ) : (
        <ul aria-label="Phrase components" className="plain-list">
          {components.map((c, i) => (
            // Keyed by position, not wordId - a reduplication holds the same word twice.
            <li key={`${i}-${c.wordId}`} className="search-result-row">
              {/* The word and its meaning, not the word_id. Picking a word_id IS picking one
                  etymology - that is the point - but the id is a key, and leading with it made the
                  list unreadable to anyone who does not already know our naming scheme. The meaning
                  is what tells two etymologies of one spelling apart, which is the actual choice
                  being made here. */}
              <span className="result-text">
                <strong>{c.displayText}</strong>
                {c.definition ? ` — ${c.definition}` : ''}
              </span>
              <button type="button" className="btn btn-danger" onClick={() => removeComponentAt(i)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="field-note">Add each word of the phrase, in order.</p>
      <SearchBox
        search={searchVocab}
        renderResult={(r) => (
          <>
            <strong>{r.displayText}</strong>
            {r.definition ? ` — ${r.definition}` : ''}
          </>
        )}
        onSelect={(r: VocabSearchResult) =>
          addComponent({ wordId: r.wordId, displayText: r.displayText, syllables: r.syllables, definition: r.definition })
        }
        selectLabel="Add"
        placeholder="Search words already in the dictionary..."
        resultsAriaLabel="Vocab search results"
        label="Search words already in the dictionary"
      />

      <p className="field-note">Not in the dictionary yet? Find the word in Wiktionary and it will be added first.</p>
      <SearchBox
        search={searchKaikki}
        renderResult={(r) => (
          <>
            <EtymologyLabel result={r} />
            <ClaimBadge result={r} />
          </>
        )}
        onSelect={(r: KaikkiSearchResult) => {
          if (!r.entryId) {
            setStatus('That Kaikki record carries no etymology id - re-ingest the corpus before citing it.');
            return;
          }
          if (r.claim?.status === 'in_dictionary') {
            setStatus(`${r.claim.wordId} already holds that etymology - add it from the dictionary search above.`);
            return;
          }
          if (isMultiWord(r.standardForms[0] ?? r.form)) {
            setStatus('That is itself a phrase, so it cannot be one word of this one.');
            return;
          }
          const form = r.standardForms[0] ?? r.form;
          setPendingPart({ entry: r, wordId: deriveWordId(form, r.glosses[0]) });
        }}
        selectLabel="Use this"
        placeholder="Search Wiktionary for a missing word..."
        resultsAriaLabel="Kaikki component search results"
        label="Search Wiktionary for a missing word"
      />

      {pendingPart ? (
        <div className="warning-banner" aria-label="New component">
          <p>
            <strong>{pendingPart.entry.standardForms[0] ?? pendingPart.entry.form}</strong> is not in the dictionary. It
            will be added first, citing its own etymology.
          </p>
          <div className="field">
            <label htmlFor="pending-part-id">Word ID</label>
            <input
              id="pending-part-id"
              type="text"
              value={pendingPart.wordId}
              onChange={(e) => setPendingPart({ ...pendingPart, wordId: e.target.value.replace(/\s+/g, '_') })}
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={createPendingPart} disabled={saving || !pendingPart.wordId}>
            Add it and use it
          </button>{' '}
          <button type="button" className="btn btn-secondary" onClick={() => setPendingPart(null)}>
            Cancel
          </button>
        </div>
      ) : null}

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

      <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
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
  /** Held HERE rather than in either tab, because switching tabs unmounts one and destroys its state -
   * which is exactly what a hand-off must survive. Both tabs stay mounted-or-not as before; only this
   * one value crosses between them. */
  const [handoff, setHandoff] = useState<PhraseHandoff | undefined>(undefined);

  function buildAsPhrase(next: PhraseHandoff) {
    setHandoff(next);
    setTab('phrase');
  }

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
      {tab === 'word' ? (
        <WordTab onOpenWord={onOpenWord} onBuildAsPhrase={buildAsPhrase} />
      ) : (
        // Cleared once consumed, so switching back to Phrase later does not re-seed a stale hand-off
        // over work in progress.
        <PhraseTab handoff={handoff} onConsumeHandoff={() => setHandoff(undefined)} />
      )}
    </section>
  );
}
