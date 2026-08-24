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
import {
  PARTS_OF_SPEECH,
  checkPhraseSpelling,
  describePhraseSpelling,
  isKnownPartOfSpeech,
  isMultiWord,
  orthographyInsensitiveForm,
  phraseTokens,
  syllabifyWord,
} from '@yoruba-student-dict-platform/shared';
import { createPhrase, createWord, getDuplicateCheck, searchKaikki, searchVocab, type DuplicateMatch } from '../api.js';
import { PhraseComposer } from './PhraseComposer.js';
import { phraseSyllables, splitPhrase } from './phraseWords.js';
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
 * can now cite (see createPhrase). `displayText` is upstream's canonical spelling and now seeds the
 * phrase's own spelling field directly; `tokens` says how many words that is, which is what the
 * hand-off message needs. */
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

/** The part of speech, as a choice from upstream's own tags rather than as free text.
 *
 * Both tabs render this - the Word tab's off-path branch and the Phrase tab - and both used to
 * render their own text input with an `e.g. noun, verb, intj` placeholder. See
 * shared/src/partsOfSpeech.ts for why the vocabulary is closed: the field is collected so the
 * entry can be sent upstream one day, and `interjection` is not a value upstream takes.
 *
 * A value already stored that is NOT in the list keeps its own option rather than being dropped.
 * Rows predate this control, and silently re-selecting the placeholder for one would turn "we
 * recorded something odd" into "we recorded nothing" the next time anybody opened the form. */
function PartOfSpeechField({
  id,
  value,
  onChange,
  note,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** An extra sentence for the tab that needs one. See the Phrase tab's, which says what its
   * default is and when to move off it. */
  note?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Part of speech</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(choose one)</option>
        {value && !isKnownPartOfSpeech(value) ? <option value={value}>{value} (already recorded)</option> : null}
        {PARTS_OF_SPEECH.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="field-note">
        Wiktionary&apos;s own categories, because this is the entry we would send there - so it has to be one of
        theirs, not the word an English grammar lesson would use.
        {note ? ` ${note}` : ''}
      </p>
    </div>
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
  prefill,
  onCreatedForPhrase,
}: {
  onOpenWord?: (wordId: string) => void;
  onBuildAsPhrase: (handoff: PhraseHandoff) => void;
  /** An etymology the Phrase tab needs as a word, pre-picked so the curator lands on a filled form
   * rather than having to search for what they just found. */
  prefill?: KaikkiSearchResult;
  /** Set only while serving that request: the created word goes back to the phrase instead of the form
   * simply clearing. */
  onCreatedForPhrase?: (part: PhrasePart) => void;
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
  /** The last thing typed into the Kaikki search, kept so the off-path branch can open with it.
   *
   * Held here rather than read out of SearchBox on demand because the box unmounts when that branch
   * opens - by then the only copy of the query would be gone. */
  const [lastQuery, setLastQuery] = useState('');
  const [exemptReason, setExemptReason] = useState('');
  /** 0018's publication fields, asked for on the off-path branch only.
   *
   * An exempt word's citation pin is empty ({}), so its part of speech and its dictionary-style
   * English gloss exist NOWHERE in the database - and it is exactly the population we would want to
   * contribute upstream one day, since a cited word is already there. Two fields at the one moment
   * the person adding it knows the answer, rather than a reconstruction job later. */
  const [pos, setPos] = useState('');
  const [englishGloss, setEnglishGloss] = useState('');
  /** The optional decomposition: which words the dictionary already holds that this one is built
   * from. Empty for most words, because most words are atomic - see createWord.ts on why that is
   * zero rows rather than a placeholder, and why recording it here does not decide the axis. */
  const [components, setComponents] = useState<PhrasePart[]>([]);
  /** Collapsed until asked for. A word's decomposition is a real question but a rare one, and a
   * component picker sitting open above the submit button reads as something to fill in - which is
   * how an optional field turns into a prompt to invent an answer. */
  const [componentsOpen, setComponentsOpen] = useState(false);
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

  // Arrive with the etymology the Phrase tab sent already picked.
  //
  // Keyed on the object identity, not on prefill?.entryId. Keying on the id meant a second
  // handoff of the SAME word did nothing - go back, pick it again, and the form silently kept
  // whatever had been typed over it. The sender mints a fresh object per handoff, so identity
  // is what "asked again" actually means; a re-render with the same object still does not
  // re-seed, which is the behaviour the id key was reaching for.
  useEffect(() => {
    if (!prefill) return;
    setSelected(prefill);
    chooseSpelling(prefill.standardForms[0] ?? prefill.form);
    setDefinitionText(prefill.glosses[0] ?? '');
    setHint(hintFromGloss(prefill.glosses[0]));
  }, [prefill]);

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
    setPos('');
    setEnglishGloss('');
    setOffPath(false);
    setDuplicates(null);
    setComponents([]);
    setComponentsOpen(false);
  }

  function startOffPath() {
    resetForm();
    setOffPath(true);
    // Opened with the word they were just searching for.
    //
    // Reaching this branch means "I looked for this and it is not there", so the spelling in
    // question is precisely the query - and the old form cleared the field and asked for it a
    // second time, at the one moment the answer was already on screen.
    //
    // Seeded whatever the query looked like, rather than only when it looks Yoruba. looksLikeYoruba
    // tests for ẹ ọ ṣ and tone marks, so it is false for `redio` - a real loanword spelling, and
    // exactly the kind of word this branch exists for, since a contributor cannot type those
    // characters in the first place. Gating on it would withhold the seeding from the common case
    // to guard against a rarer one that is visible and one edit away: the field is the first thing
    // under the warning banner, with its tone grids underneath.
    setSelectedForm(lastQuery.trim());
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
        syllables: offPath ? composedSyllables : syllablesText.split(',').map((s) => s.trim()).filter(Boolean),
        definition: definitionText.trim() || null,
        citation: offPath ? { exemptReason: exemptReason.trim() } : { entryId: selected!.entryId! },
        // Omitted entirely when empty, rather than sent as []. An atomic word makes no claim about
        // its parts, and a present-but-empty list would say it had considered the question - which
        // is a different thing from a curator never opening the section.
        ...(components.length > 0 ? { components: components.map((c) => c.wordId) } : {}),
        // Off-path only: a cited word reads both from its pin, and 0018 keeps these as overrides
        // precisely so the cited majority needs no second copy of what upstream already said.
        ...(offPath ? { pos: pos.trim() || null, englishGloss: englishGloss.trim() || null } : {}),
      });
      setStatus(`Added ${wordIdPreview} to vocabulary.`);
      const syllablesOut = offPath ? composedSyllables : syllablesText.split(',').map((x) => x.trim()).filter(Boolean);
      // Clear the form and go back to the top. Adding words is a repeated action, and the confirmation
      // used to appear at the bottom of a long form with the just-submitted values still in it - so the
      // next word meant scrolling back up past everything, and the enabled button re-POSTed a duplicate.
      resetForm();
      if (onCreatedForPhrase) {
        // Straight back to the phrase that needed it, with this word already in place.
        onCreatedForPhrase({
          wordId: wordIdPreview,
          displayText: selectedForm,
          syllables: syllablesOut,
          definition: definitionText.trim() || null,
        });
        return;
      }
      topRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // The syllables of a spelling the contributor authored themselves, read back off the composer
  // rather than typed beside it - the same one-source-of-truth rule the Phrase tab and the audio
  // screen already follow. Only the off-path branch uses it; a cited word's split still has its own
  // editable field, because there the spelling was authored upstream and this is a split of
  // somebody else's text.
  const composedSyllables = phraseSyllables(splitPhrase(selectedForm).words);
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
            onQueryChange={setLastQuery}
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
            // The one branch on this screen where a human AUTHORS the spelling, and it was the one
            // with no tone grid.
            //
            // A cited word arrives spelled by upstream, tones included, and the radios below only
            // choose between forms Wiktionary already wrote. This branch had a bare text box, so
            // the tone marks had to be typed - the single thing this app is built so that nobody
            // ever has to do, because no phone keyboard produces them and `ẹ` `ọ` `ṣ` are not on
            // one either. Whatever came out became golden_record, and this is precisely the
            // population where that is permanent: an exempt word has no upstream form to be checked
            // against, ever. So a word entered here toneless stays toneless until a human notices.
            //
            // Same composer the Phrase tab and the entry axis use, so a word is authored the way
            // everything else is: type the letters, tap the six the keyboard lacks, choose the tone
            // on a grid and the mark is generated. It grids a hyphenated form too, which a
            // loanword or a compound may well be.
            <PhraseComposer
              id="word-spelling"
              label="Spelling"
              placeholder="e.g. rédíò"
              value={selectedForm}
              onChange={setSelectedForm}
            />
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

          {offPath ? (
            // Read, not typed. The grids above produced these, so a second box to retype them in
            // could only ever disagree with the spelling - and a split that disagrees with its own
            // display_text is a real production defect (agunfon_giraffe), not a hypothetical one.
            <p>
              Syllables: <strong>{composedSyllables.join(' · ')}</strong>
            </p>
          ) : (
            <div className="field">
              <label htmlFor="word-syllables-field">Syllables (comma-separated)</label>
              <input
                id="word-syllables-field"
                type="text"
                value={syllablesText}
                onChange={(e) => setSyllablesText(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="word-definition-field">Student definition</label>
            {selected && selected.glosses.length > 0 ? (
              <p className="field-note" aria-label="Wiktionary glosses">
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
            <>
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
              <PartOfSpeechField id="word-pos-field" value={pos} onChange={setPos} />
              <div className="field">
                <label htmlFor="word-gloss-field">English gloss</label>
                <input
                  id="word-gloss-field"
                  type="text"
                  value={englishGloss}
                  onChange={(e) => setEnglishGloss(e.target.value)}
                  placeholder="e.g. radio"
                />
                <p className="field-note">
                  Ordinary dictionary wording, for the entry we would send upstream one day - not the simplified
                  student definition above. A word with no Wiktionary entry has this recorded nowhere else.
                </p>
              </div>
            </>
          ) : null}

          {/* Optional, collapsed, and last of the content fields.
              
              A word's components are a claim ABOUT it rather than its identity - the citation above
              is the identity (0017) - so this asks a question most words answer with silence, and
              the section stays shut until somebody has one to give. Opening it and picking nothing
              is the same as never opening it: submit sends no components either way. */}
          <div className="field">
            {componentsOpen ? (
              <div aria-label="Word components section">
                <p>
                  <strong>What is this word built from?</strong>{' '}
                  <button type="button" className="btn btn-secondary" onClick={() => setComponentsOpen(false)}>
                    Hide
                  </button>
                </p>
                <p className="field-note">
                  Only for a word that really is made of words we already hold - a compound like `ojúlé`
                  from `ojú` and `ilé`. Most words are not, and leaving this empty is the ordinary
                  answer. It is recorded as a proposal: the etymology review still asks a curator to
                  confirm it.
                </p>
                {components.length === 0 ? (
                  <p>No components picked yet.</p>
                ) : (
                  <ul aria-label="Word components" className="plain-list">
                    {components.map((c, i) => (
                      // Keyed by position, not wordId - a reduplication holds the same word twice.
                      <li key={`${i}-${c.wordId}`} className="search-result-row">
                        <span className="result-text">
                          <strong>{c.displayText}</strong>
                          {c.definition ? ` — ${c.definition}` : ''}
                        </span>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => setComponents(components.filter((_, j) => j !== i))}
                        >
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
                  onSelect={(r: VocabSearchResult) =>
                    setComponents((prev) => [
                      ...prev,
                      { wordId: r.wordId, displayText: r.displayText, syllables: r.syllables, definition: r.definition },
                    ])
                  }
                  renderAction={(r: VocabSearchResult) => (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        setComponents((prev) => [
                          ...prev,
                          { wordId: r.wordId, displayText: r.displayText, syllables: r.syllables, definition: r.definition },
                        ])
                      }
                    >
                      Add as component
                    </button>
                  )}
                  placeholder="Search words already in the dictionary..."
                  resultsAriaLabel="Word component search results"
                  label="Search words this one is built from"
                />
              </div>
            ) : (
              <p className="field-note">
                <button type="button" className="btn btn-secondary" onClick={() => setComponentsOpen(true)}>
                  Is this word built from other words? (optional)
                </button>
                {/* Said out loud when there ARE components and the section is shut, because a
                    collapsed section that hides a filled-in answer is how a submission comes to
                    carry something nobody remembers entering. */}
                {components.length > 0 ? (
                  <span aria-label="Components picked while collapsed">
                    {' '}
                    {components.length} picked: {components.map((c) => c.displayText).join(' + ')}
                  </span>
                ) : null}
              </p>
            )}
          </div>

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

/** A phrase being built, held by AddWord rather than by the Phrase tab.
 *
 * Because a missing component is now added on the WORD tab - one creation path for words, not two - and
 * switching tabs unmounts the tab being left. A half-built phrase has to survive that round trip, so the
 * draft lives one level up and the Phrase tab is controlled. */
interface PhraseDraft {
  /** The phrase's spelling, when it is NOT simply its components separated by spaces.
   *
   * Empty means "the components spell it", and componentSpelling below supplies the form. Two
   * mistakes bracket this field and it has now made both:
   *
   *   Derived only  - display_text WAS `components.map(c => c.displayText).join(' ')`, with no field
   *                   for it and no way to correct it, and the server re-derived it the same way on
   *                   every later etymology edit. So a phrase whose surface form is not its parts run
   *                   together could not be entered at all: `o ṣé` (upstream's own canonical form for
   *                   the `o ṣe` entry, IPA /ō ʃé/) came out as `o ṣe`, at a tone nobody says,
   *                   because the component `ṣe` is spelled at mid tone in its own right. Minting a
   *                   second word to carry the high tone is not available either - that word would
   *                   cite `ṣe`'s etymology, and 0017 makes one etymology one word.
   *   Authored only - the fix went to the other end: the field became required, on a blank tone grid,
   *                   for every phrase. But the components ALREADY say how the phrase is spelled in
   *                   the ordinary case, which is most cases - a curator who has just picked `ojú`
   *                   and `sánmà` from the dictionary has spelled `ojú sánmà`, and was then asked to
   *                   spell it again, tone by tone, from nothing. Re-entry is not confirmation: it is
   *                   a second chance to differ from the words that were just picked.
   *
   * So the components propose and the curator disposes. Storage is unchanged - what is submitted is
   * always an explicit spelling (see createPhrase, which stores what it is given) - and the
   * difference is only in who has to type it. */
  displayText: string;
  /** Whether displayText is the curator's own, and therefore no longer follows the components.
   *
   * A flag rather than the tempting shortcut of "an empty field means use the components": that
   * shortcut makes the field refill itself the moment it is emptied, so selecting all and retyping
   * appends to a default that came back while you were deleting. An explicit flag also lets an empty
   * spelling be a real answer - a curator who deleted it meant to - and getting the default back is
   * a button that says so, rather than a side effect of deleting. */
  spellingEdited: boolean;
  components: PhrasePart[];
  hint: string;
  adopted: KaikkiSearchResult | null;
  /** 0018's publication fields, collected only when this phrase will have no citation pin to read
   * them from - i.e. when it is locally composed rather than adopted from upstream. */
  pos: string;
  englishGloss: string;
  /** The student definition, when it is NOT the dictionary wording verbatim.
   *
   * Same two-field shape as the spelling above, for the same reason: the answer is usually already
   * on the screen. `ojú sánmà` glossed "the sky, the firmament" for upstream is glossed "the sky"
   * for a student, and a great many are simply the same sentence - so the dictionary wording is the
   * default and simplifying it is an edit, rather than the field starting empty and a curator
   * retyping what they wrote one box up.
   *
   * They stay two COLUMNS whatever the wording (0018: one column cannot serve a Wiktionary sense
   * line and a learner at once). A copy as a starting value is not a claim that they are the same
   * field - it is a claim that they often begin the same, which is what a default is for. */
  definition: string;
  definitionEdited: boolean;
}

/** What the components spell on their own: each one's spelling, in order, separated by a space.
 *
 * The default spelling, and also the thing checkPhraseSpelling compares against - deliberately the
 * same rule in both places, because a default a curator accepts must be a default the warning below
 * then stays quiet about. */
function componentSpelling(components: PhrasePart[]): string {
  return components.map((c) => c.displayText).join(' ');
}

/** `phrase` for the part of speech, not the blank option.
 *
 * The corpus statistic that argued against this default - just 2.4% of upstream's 536 multi-word
 * entries carry the pos `phrase`, against 56% nouns - is real, and measures the wrong population.
 * This field is only ever shown for a LOCALLY COMPOSED phrase; an adopted one takes pos from the
 * entry it cites, and every one of those 536 is adopted. What we compose ourselves is mostly what
 * upstream has no entry for, which skews hard the other way: set expressions, greetings, whole
 * sentences from a lesson - things whose grammatical category genuinely is `phrase` or `proverb`,
 * not a noun. `o ṣé` really is an interjection and `ojú sánmà` really is a noun, so the field stays
 * editable and its note says to change it; but the blank option is not a neutral starting point,
 * it is a required answer to a question most of these entries answer the same way. */
const EMPTY_DRAFT: PhraseDraft = {
  displayText: '',
  spellingEdited: false,
  components: [],
  hint: '',
  adopted: null,
  pos: 'phrase',
  englishGloss: '',
  definition: '',
  definitionEdited: false,
};

function PhraseTab({
  handoff,
  onConsumeHandoff,
  onOpenWord,
  draft,
  setDraft,
  onNeedWord,
}: {
  handoff?: PhraseHandoff;
  onConsumeHandoff: () => void;
  onOpenWord?: (wordId: string) => void;
  draft: PhraseDraft;
  setDraft: (next: PhraseDraft) => void;
  /** "This word is not in the dictionary yet" - hands it to the Word tab to be added properly, rather
   * than creating it from a stripped-down form here. */
  onNeedWord: (entry: KaikkiSearchResult) => void;
}) {
  const { components, hint, adopted, pos, englishGloss } = draft;
  /** The spelling in force: the curator's, once they have touched the field, and the components'
   * until then.
   *
   * Derived on read rather than copied into the draft each time a component is added, so that
   * "follows the components" is one condition in one place instead of a sync rule that has to fire
   * on every add, every remove and every hand-off - and cannot be forgotten in one of them. */
  const proposedSpelling = componentSpelling(components);
  const displayText = draft.spellingEdited ? draft.displayText : proposedSpelling;
  /** The dictionary wording this phrase has, from wherever it has one.
   *
   * `englishGloss` is populated in both cases and only SUBMITTED in one: a locally composed phrase
   * has a curator type it, and an adopted one has it seeded from the entry's first gloss (which is
   * also what its citation pin will hold, so the field is not rendered). Reading the default off one
   * value rather than two keeps "the student definition starts as the dictionary wording" a single
   * rule instead of one per path. */
  const proposedDefinition = englishGloss.trim();
  const definition = draft.definitionEdited ? draft.definition : proposedDefinition;
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const topRef = useRef<HTMLDivElement | null>(null);
  const setComponents = (next: PhrasePart[]) => setDraft({ ...draft, components: next });
  const setHint = (next: string) => setDraft({ ...draft, hint: next });

  // Seed from the Word tab. Runs once per handoff: the tab is not unmounted between them, so keying the
  // effect on the spelling is what makes a second hand-off take effect.
  //
  // The spelling now arrives filled in, with upstream's own canonical form for the entry the curator
  // picked - tone marks included, which is the half that was being lost. `tokens` was documented as
  // seeding the form and never could: there was no spelling field to seed, so it only ever supplied a
  // count for the message below, which is all it is used for now.
  useEffect(() => {
    if (!handoff) return;
    setDraft({
      ...EMPTY_DRAFT,
      displayText: handoff.displayText,
      // Authored, though not by this curator: it is upstream's own canonical form for the entry they
      // picked, tone marks included. Components added afterwards must not overwrite it - the whole
      // point of carrying it over is that it is better than what the parts spell.
      spellingEdited: true,
      hint: hintFromGloss(handoff.entry?.glosses[0]),
      adopted: handoff.entry ?? null,
      // Upstream's tag when there is an entry behind the hand-off, and otherwise the default rather
      // than blank - a hand-off with no entry is a locally composed phrase like any other, and it is
      // the one that will actually show this field.
      pos: handoff.entry?.pos || EMPTY_DRAFT.pos,
      englishGloss: handoff.entry?.glosses[0] ?? '',
    });
    setStatus(
      `${handoff.displayText} is ${handoff.tokens.length} words, so it is a phrase. Its spelling is filled in ` +
        `below - add the word behind each part, and anything missing from the dictionary can be added from ` +
        `Wiktionary without leaving this tab.`,
    );
    onConsumeHandoff();
  }, [handoff?.displayText]);

  const { words: phraseWordList } = splitPhrase(displayText);
  const syllables = phraseSyllables(phraseWordList);
  const spellingCheck = checkPhraseSpelling(displayText, components.map((c) => c.displayText));
  // Silent until there is something to compare against. With no components picked yet, EVERY word of
  // the phrase is one the components do not account for - true, and useless, since the list above
  // already says none have been picked. A warning that fires through the whole of normal authoring is
  // one people learn to scroll past, which is how the old duplicate warning came to be ignored.
  const spellingNote = components.length === 0 ? null : describePhraseSpelling(spellingCheck);
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
    setComponents([...components, part]);
  }

  function removeComponentAt(index: number) {
    setComponents(components.filter((_, i) => i !== index));
  }

  function resetForm() {
    setDraft(EMPTY_DRAFT);
    setDuplicates(null);
  }

  async function submit() {
    if (components.length === 0) {
      setStatus('A phrase needs at least one component.');
      return;
    }
    if (!displayText.trim()) {
      // Only reachable if every component's own spelling is blank, which golden_record does not
      // hold - a backstop against submitting an empty display_text, not a step in the normal flow.
      setStatus('This phrase has no spelling - write it above, or pick components that have one.');
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
        displayText: displayText.trim(),
        syllables,
        components: components.map((c) => c.wordId),
        // Always sent, cited or not: the student definition is ours in both cases. There is no pin
        // to fall back to for this one - a phrase created without it was simply meaningless.
        definition: definition.trim() || null,
        // The phrase's own etymology, when it has one. Upstream has 480 multi-word entries, and their
        // meaning is not the sum of their parts - so recording it is not redundant with the components.
        ...(adopted?.entryId ? { citation: { entryId: adopted.entryId } } : {}),
        // Only for a locally composed phrase. An adopted one takes the by-nature citation, and its pin
        // already holds both - see 0018 on why these are overrides rather than copies.
        ...(adopted
          ? {}
          : { pos: pos.trim() || null, englishGloss: englishGloss.trim() || null }),
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

  /** Picking an upstream record, which now means one of two things depending on the record.
   *
   * Lifted out of the search box's onSelect so the per-row button can call it too - the two rows
   * need different verbs, and a shared selectLabel could only name one of the two jobs. */
  function selectUpstream(r: KaikkiSearchResult) {
        if (!r.entryId) {
          setStatus('That Kaikki record carries no etymology id - re-ingest the corpus before citing it.');
          return;
        }
        if (r.claim?.status === 'in_dictionary') {
          setStatus(`${r.claim.wordId} already holds that etymology - add it from the dictionary search above.`);
          return;
        }
        // A multi-word hit IS this phrase, not a word of it.
        //
        // It used to be refused outright - "that is itself a phrase, so it cannot be one word of
        // this one" - which has the right object and the wrong outcome. Upstream holds 480
        // multi-word entries and `o ṣé` is one of them, spelled with the tone we would otherwise
        // guess at; the only route to adopting one was to start on the WORD tab, be refused
        // there, and be handed over. So a curator who correctly began on the Phrase tab was told
        // no, with nothing to say the same search one tab away would have worked.
        //
        // Adopting in place is the same seeding the hand-off does, minus the reset: components
        // already picked are kept, because a curator who added `o` before finding the whole
        // entry has said something true about this phrase and should not have to say it twice.
        // If those components disagree with upstream's spelling, the spelling report above says
        // so in its own words rather than this refusing on their behalf.
        if (isMultiWord(r.standardForms[0] ?? r.form)) {
          const form = r.standardForms[0] ?? r.form;
          setDraft({
            ...draft,
            displayText: form,
            // Same as the hand-off: upstream's spelling stands until a human changes it, and the
            // components already picked stay as they are. The spelling report below is what says so
            // when the two disagree.
            spellingEdited: true,
            hint: hint || hintFromGloss(r.glosses[0]),
            adopted: r,
            pos: r.pos,
            englishGloss: r.glosses[0] ?? '',
          });
          setStatus(
            `Citing ${form} as this phrase, with Wiktionary's own spelling. Add the word behind each part below - ` +
              `its meaning is not the sum of them, which is why it has an etymology of its own.`,
          );
          return;
        }
        // Sent to the WORD tab rather than created from a cut-down form here. Words are created in one
        // place, with the whole form that belongs to that job - spelling choice among standardForms,
        // syllables, a student definition, the duplicate check - none of which a component picker
        // should be reimplementing. The phrase draft is held by AddWord, so it survives the trip and
        // the new word is appended on the way back.
        onNeedWord(r);
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

      <p className="field-note">
        Add each word of the phrase, in order. This searches words the dictionary already holds - to
        change an existing phrase, open it and use its Etymology tab.
      </p>
      <SearchBox
        search={searchVocab}
        renderResult={(r) => (
          <>
            <strong>{r.displayText}</strong>
            {r.definition ? ` — ${r.definition}` : ''}
            {/* Said out loud, because a phrase offered as a candidate component of a phrase read as an
                invitation to duplicate a word that already existed. Nesting is not forbidden - the
                schema allows it and a proverb containing an idiom is conceivable - but it must be a
                choice rather than a surprise. */}
            {r.entryType === 'phrase' ? (
              <>
                {' '}
                <span className="badge">already a phrase</span>
              </>
            ) : null}
          </>
        )}
        onSelect={(r: VocabSearchResult) =>
          addComponent({ wordId: r.wordId, displayText: r.displayText, syllables: r.syllables, definition: r.definition })
        }
        // Both actions, because "Add" alone had no object: it means "use as one word of the phrase I am
        // building", and with nothing being built it reads as "create this". Opening the word is what a
        // curator who found an existing entry actually wanted.
        renderAction={(r: VocabSearchResult) => (
          <span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                addComponent({
                  wordId: r.wordId,
                  displayText: r.displayText,
                  syllables: r.syllables,
                  definition: r.definition,
                })
              }
            >
              Add as component
            </button>
            {onOpenWord ? (
              <>
                {' '}
                <button type="button" className="btn btn-secondary" onClick={() => onOpenWord(r.wordId)}>
                  Open {r.wordId}
                </button>
              </>
            ) : null}
          </span>
        )}
        placeholder="Search words already in the dictionary..."
        resultsAriaLabel="Vocab search results"
        label="Search words already in the dictionary"
      />

      <p className="field-note">
        Not in the dictionary yet? Find it in Wiktionary. A single word is added as a word first and comes back as a
        component; a multi-word entry is this phrase itself, and picking it fills the spelling in and cites it.
      </p>
      <SearchBox
        search={searchKaikki}
        renderResult={(r) => (
          <>
            <EtymologyLabel result={r} />
            <ClaimBadge result={r} />
          </>
        )}
        onSelect={selectUpstream}
        // Two different jobs on one result list, so the verb is per row rather than one label for
        // both. A row that says "Add it as a word first" and a row that says "Use as this phrase"
        // are doing genuinely different things, and a single shared label could only describe one
        // of them - which is how the multi-word case came to look unavailable here.
        renderAction={(r: KaikkiSearchResult) => (
          <button type="button" className="btn btn-secondary" onClick={() => selectUpstream(r)}>
            {isMultiWord(r.standardForms[0] ?? r.form) ? 'Use as this phrase' : 'Add it as a word first'}
          </button>
        )}
        placeholder="Search Wiktionary for this phrase, or for a missing word..."
        resultsAriaLabel="Kaikki component search results"
        label="Search Wiktionary for this phrase, or for a missing word"
      />

      {/* The spelling, after the components, because in the ordinary case picking the words IS
          spelling the phrase. What the parts spell is shown as a read-out and submitted as it
          stands; the tone grid opens only for the phrase that is not said that way - a contraction,
          an elision, a tone change - which makes typing it the branch rather than the entrance.

          The order is load-bearing, not taste. A spelling field at the top of the form is an
          invitation to fill it in first, and a curator who does that has answered from memory the
          question the components were about to answer from the dictionary - which is how `o ṣe`
          came to be entered at a tone nobody says. */}
      {draft.spellingEdited ? (
        <>
          <PhraseComposer
            id="phrase-spelling"
            label="The phrase, spelled as it is said"
            placeholder="e.g. o ṣé"
            value={displayText}
            onChange={(next) => setDraft({ ...draft, displayText: next, spellingEdited: true })}
          />
          {/* The way back, offered whenever there is a default to return TO - including before the
              correction has changed anything, which is exactly the state a curator who opened this
              by mistake is in. A door that unlocks only once you have moved is not a way back. */}
          {components.length > 0 ? (
            <p className="field-note">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDraft({ ...draft, displayText: '', spellingEdited: false })}
              >
                Spell it from the components ({proposedSpelling})
              </button>
            </p>
          ) : null}
        </>
      ) : components.length > 0 ? (
        <div className="field">
          <p aria-label="Spelled from the components">
            The phrase, spelled from the components: <strong>{proposedSpelling}</strong>
          </p>
          <p className="field-note">
            Add or remove words above and this follows. Correct it only if the phrase is not said the
            way its parts are written.
          </p>
          <p className="field-note">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDraft({ ...draft, displayText: proposedSpelling, spellingEdited: true })}
            >
              That is not how it is said - correct the spelling
            </button>
          </p>
        </div>
      ) : null}

      <p>
        Syllables: <strong>{syllables.join(' · ')}</strong>
      </p>

      {/* The old rule, demoted to a report. A phrase that is not its parts run together is
          usually a real fact about Yoruba - an elision, a contraction, a tone change, a clipping -
          and occasionally a typo, and nothing in the data tells them apart. So this says what
          differs and lets a curator decide, the same way the duplicate check below does. */}
      {spellingNote ? (
        <div role="alert" aria-label="Spelling differs from components" className="warning-banner">
          <p>
            This phrase is not its components run together: {spellingNote}.
          </p>
          <p className="field-note">
            Expected from the parts: <strong>{spellingCheck.joined}</strong>. That is fine if the phrase really is
            written differently - a contraction, an elision, a tone change - and worth a second look if it is not.
          </p>
        </div>
      ) : null}

      {/* Collected only for a locally composed phrase. An adopted one has a citation pin holding
          both already; asking again would be asking a curator to retype what upstream said. */}
      {adopted ? null : (
        <>
          {/* Still two different facts: that this entry is a phrase is recorded structurally, by
              having components - createPhrase writes entry_type without asking - while this asks
              what the phrase is GRAMMATICALLY, which upstream tags separately. What changed is the
              default. See EMPTY_DRAFT for why the corpus figure that argued for a blank one (2.4%
              of multi-word entries tagged `phrase`) measures only adopted entries, which never
              reach this field. */}
          <PartOfSpeechField
            id="phrase-pos-field"
            value={pos}
            onChange={(next) => setDraft({ ...draft, pos: next })}
            note={
              'Defaults to `phrase`, which is right for a set expression or a whole sentence. Change it when ' +
              'this one is grammatically something narrower - `o ṣé` is an interjection, `ojú sánmà` is a noun.'
            }
          />
          <div className="field">
            <label htmlFor="phrase-gloss-field">English gloss</label>
            <input
              id="phrase-gloss-field"
              type="text"
              value={englishGloss}
              onChange={(e) => setDraft({ ...draft, englishGloss: e.target.value })}
              placeholder="e.g. thank you (non-honorific, to one person)"
            />
            <p className="field-note">
              Ordinary dictionary wording, for the entry we would send upstream. Nothing else records it for a
              phrase we composed ourselves - and the student definition below starts as a copy of it.
            </p>
          </div>
        </>
      )}

      {/* Asked for whatever the citation says, unlike the two fields above. A pin holds the wording
          upstream uses; it cannot hold the wording we would put in front of a student, because that
          wording is ours. So an adopted phrase needs this field exactly as much as a composed one -
          and this screen had it for neither, which is why createPhrase never even named the column. */}
      <div className="field">
        <label htmlFor="phrase-definition-field">Student definition</label>
        {adopted && adopted.glosses.length > 0 ? (
          <p className="field-note" aria-label="Wiktionary glosses">
            Wiktionary says: {adopted.glosses.join('; ')}
          </p>
        ) : null}
        <textarea
          id="phrase-definition-field"
          value={definition}
          onChange={(e) => setDraft({ ...draft, definition: e.target.value, definitionEdited: true })}
        />
        <p className="field-note">
          Plain wording a student will understand. It starts as the dictionary wording{adopted ? '' : ' above'} and
          simplifying it is expected - it is a simplification, not a correction.
        </p>
        {/* The same undo the spelling has, and offered on the same condition: only when the two have
            actually come apart. A curator who has simplified the wording and then wants the original
            back should not have to find it in another field and retype it. */}
        {draft.definitionEdited && proposedDefinition && definition !== proposedDefinition ? (
          <p className="field-note">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDraft({ ...draft, definition: '', definitionEdited: false })}
            >
              Use the dictionary wording ({proposedDefinition})
            </button>
          </p>
        ) : null}
      </div>

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
  /** The phrase being built. Held here so it survives the Phrase -> Word -> Phrase round trip a missing
   * component now takes: switching tabs unmounts the tab being left, and losing a half-built phrase to
   * go and add one of its words would make the trip not worth taking. */
  const [draft, setDraft] = useState<PhraseDraft>(EMPTY_DRAFT);
  /** The etymology the Phrase tab asked to have added as a word, while that is being served. */
  const [wordForPhrase, setWordForPhrase] = useState<KaikkiSearchResult | undefined>(undefined);

  function buildAsPhrase(next: PhraseHandoff) {
    setHandoff(next);
    setTab('phrase');
  }

  function needWord(entry: KaikkiSearchResult) {
    setWordForPhrase(entry);
    setTab('word');
  }

  function componentCreated(part: PhrasePart) {
    setDraft((prev) => ({ ...prev, components: [...prev.components, part] }));
    setWordForPhrase(undefined);
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
      {wordForPhrase ? (
        <p className="field-note" aria-label="Adding for a phrase">
          Adding <strong>{wordForPhrase.standardForms[0] ?? wordForPhrase.form}</strong> as a word first. It will be added
          to the phrase you were building as soon as it is saved.
        </p>
      ) : null}
      {tab === 'word' ? (
        <WordTab
          onOpenWord={onOpenWord}
          onBuildAsPhrase={buildAsPhrase}
          prefill={wordForPhrase}
          onCreatedForPhrase={wordForPhrase ? componentCreated : undefined}
        />
      ) : (
        // Cleared once consumed, so switching back to Phrase later does not re-seed a stale hand-off
        // over work in progress.
        <PhraseTab
          handoff={handoff}
          onConsumeHandoff={() => setHandoff(undefined)}
          onOpenWord={onOpenWord}
          draft={draft}
          setDraft={setDraft}
          onNeedWord={needWord}
        />
      )}
    </section>
  );
}
