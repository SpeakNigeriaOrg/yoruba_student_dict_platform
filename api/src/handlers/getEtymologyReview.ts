// handlers/getEtymologyReview.ts
//
// Backs GET /words/{wordId}/etymology - what this word is made of.
//
// ---------------------------------------------------------------------------
// ONE direction, on purpose
// ---------------------------------------------------------------------------
// This used to return the reverse direction too - usedInProposal ("which other words use this
// one") and usedAsComponentOf (the confirmed version of the same). Both are gone, because
// neither was ever actionable HERE: applyEtymologyDecision only ever writes component rows for
// the word under review (see its delete/insert, scoped to `word_id = $1`), so nothing on this
// screen could move an item from usedInProposal into usedAsComponentOf. That transition happens
// when the OTHER word's own etymology axis is decided.
//
// This endpoint's old header claimed otherwise - that "accepting that this word IS a component of
// some other word" went through accept_proposed unchanged. It never did: accept_proposed submits
// componentsProposal only. So the reverse direction was decoration on 47 of 80 cited words, and
// after the request flow landed it became worse than decoration - the shared row component told a
// reader to "add it from the picker below", which would have recorded the inverse relationship.
//
// Derived terms are the example axis's subject, and it teaches them properly ("A phrase built
// from this one: adìyẹ → abo adìyẹ"). They do not belong here.
//
// componentsAxisFields still computes both - it is verified against the Python engine's own
// output and that parity is worth more than deleting two fields from it. They stop at this
// boundary rather than being carried into a response nobody should render.

import {
  buildComponentOwnersIndex,
  buildVocabSpellingIndex,
  componentsAxisFields,
  diagnoseEntry,
  normalizeLoanLanguage,
  wiktionaryLoanTerm,
  orthographyInsensitiveForm,
  type ComponentsProposalItem,
  type DiagnosticsOverrides,
} from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadKaikkiSensesForKey } from '../kaikkiData.js';
import { loadAxisDecided, loadDefinition, loadVocab, type AxisDecided } from '../reviewShared.js';
import { WordNotFoundError } from './errors.js';
import { loadMyEntryAnswer, type MyEntryAnswer } from '../myEntryAnswer.js';

/** Deliberately NOT `extends ComponentsAxisFieldsResult`: that type carries the reverse-direction
 * fields, and spreading it is how they reached this response in the first place. Listing what the
 * screen actually uses means a field added there cannot silently arrive here. */
/** A proposal item plus the words behind its possibleMatches - the ones we hold under the same
 * letters with different tone marks - so the screen can name them ("we have lá, to be big")
 * instead of gesturing at an unnamed near-miss. Added here rather than in shared's resolver,
 * whose output is pinned field-for-field to the Python engine's by the parity tests. */
export interface ProposalItemWithNearMatches extends ComponentsProposalItem {
  possibleMatchWords: { wordId: string; displayText: string; definition: string | null }[];
  /** The gloss Wiktionary's etymology template gives this part - which sense of the spelling it
   * means (`t2=to cut, to divide` for là in ìlà). Null when the template gives none. */
  wiktionaryGloss: string | null;
  /** Every Wiktionary etymology this part may be, best first (0031) - so a reviewer can pick the
   * right one from the proposal itself, rather than retyping the spelling into a search. Each says
   * whether we already hold a word citing it. The first is kaikki-yoruba's best match for the
   * template's gloss. */
  wiktionaryCandidates: WiktionaryPartCandidate[];
}

export interface Borrowing {
  /** Wiktionary language code (shared/src/loanLanguages.ts). */
  from: string;
  term: string | null;
}

export interface MyEtymologyAnswer {
  /** true: they said it has no parts. */
  atomic: boolean;
  /** What they said about borrowing; undefined for an answer given before 0032. */
  borrowing?: Borrowing | null;
  /** In order. `pending` marks a part they requested that a curator has not added yet. */
  components: { wordId: string; displayText: string; definition: string | null; pending: boolean }[];
  /** Whether it says something other than the record - what the screen's marker is for. */
  differsFromRecord: boolean;
}

export interface WiktionaryPartCandidate {
  entryId: string;
  form: string;
  pos: string;
  etymologyNumber: string | null;
  glosses: string[];
  /** Our word citing this etymology, when we hold one. */
  held: { wordId: string; displayText: string } | null;
}

export interface EtymologyReviewResult {
  wordId: string;
  displayText: string;
  syllables: string[];
  definition: string | null;
  /** 'phrase' for a composed multi-word entry, null for a single word.
   *
   * The screen needs this because the two ask genuinely different questions. A phrase's identity
   * IS its constituent words - that is literally what its citation exemption says - so "does this
   * break into parts?" and "it has no parts" are not available answers about one, and it was being
   * offered both. */
  entryType: 'phrase' | null;
  /** The word as this caller has said it is, when that differs from the record - shown in place
   * of displayText / definition above. See myEntryAnswer.ts. The Kaikki lookup and component
   * proposal still key on the record's spelling: they are about which etymology the word is. */
  myProposedEntry: MyEntryAnswer | null;
  /** This caller's own active answer on THIS axis - what they said the word is made of. Null when
   * they have not answered. See loadMyEtymologyAnswer. */
  myEtymologyAnswer: MyEtymologyAnswer | null;
  /** Loanword (0032). `borrowing` is the record; `wiktionaryBorrowing` is what the cited
   * Wiktionary entry's own {{bor}} template says - the screen starts from it when the record is
   * silent, so a reviewer confirms rather than re-enters. */
  borrowing: Borrowing | null;
  wiktionaryBorrowing: Borrowing | null;
  componentsProposal: ProposalItemWithNearMatches[];
  components: string[];
  /** The decomposition WE hold, resolved to spellings, with the atomic self-reference already
   * collapsed to an empty list.
   *
   * `components` above is the raw axis field, which reports an atomic word as `[wordId]` and every
   * component as a bare id. Both are wrong to put in front of a person: the screen was repeating
   * the `[wordId]` test in two places and falling back to printing word_ids when it had no label
   * for one, and this screen's own rule is that a component is shown as the word, not the key.
   *
   * Carries `definition` for the same reason componentsProposal.resolvedDefinition does: a
   * spelling is not a word. `sùn` alone is at least three things (sleep, aim, complain), and this
   * IS what got confirmed as a part - showing only the spelling would tell a reader which word was
   * picked no better than the proposal did before resolvedDefinition existed.
   *
   * Kept as a separate field rather than a change to `components`, whose shape componentsAxisFields
   * owns and other callers read. */
  componentsOnRecord: Array<{ wordId: string; displayText: string; definition: string | null }>;
  /** Whether each of the platform's review axes already has a
   * word_decisions row for this word - shown as read-only context so a
   * curator reviewing etymology (the only axis this screen has an
   * interactive decision UI for) isn't left guessing whether the entry
   * axis has been decided elsewhere. */
  axisDecided: AxisDecided;
  /** Kaikki's free-text etymology prose for this word's matched sense, if
   * any - distinct from componentsProposal (the structured
   * decomposition). A real fraction of entries have only this, no
   * structured template at all - worth surfacing even when nothing could
   * be mechanically decomposed. */
  etymologyText: string | null;
}

/** Only the one field componentsAxisFields actually reads from overrides
 * (targetSpellingConfirmed - whether a resolved target word already has a
 * confirmed spelling decision) - no need to merge every decision axis
 * into a full DiagnosticsOverrides map for that single check.
 *
 * Reads the 'entry' axis: since 0011_merge_entry_axis.sql the spelling
 * `action` lives on the merged entry decision alongside the definition
 * fields, so a word's spelling is confirmed exactly when its entry
 * decision carries an action. */
async function loadSpellingConfirmedOverrides(client: Queryable): Promise<DiagnosticsOverrides> {
  const rows = await client.query<{ word_id: string; action: string | null }>(
    `select word_id, decision->>'action' as action from word_decisions
     where axis = 'entry' and decision->>'action' is not null`,
  );
  const overrides: DiagnosticsOverrides = {};
  for (const row of rows.rows) {
    overrides[row.word_id] = { action: row.action as 'keep_ours' | 'adopt_kaikki' | 'select_candidate' };
  }
  return overrides;
}

/** The caller's own active etymology answer, so coming back to this tab shows what they said.
 *
 * An answer is one vote; the record changes only when a curator confirms. So after saving, the
 * screen used to reload the record - which their vote had not changed - and their answer looked
 * lost, exactly the defect myEntryAnswer.ts fixed for the entry axis. Read from resolved_value (the
 * outcome frozen at submission). A part they requested from Wiktionary has no golden_record row
 * until a curator approves it, so its name comes from the pending request. */
export async function loadMyEtymologyAnswer(
  client: Queryable,
  wordId: string,
  userId: string,
  recordComponents: string[],
  recordBorrowing: Borrowing | null = null,
): Promise<MyEtymologyAnswer | null> {
  const { rows } = await client.query<{
    resolved_value: { components?: string[]; atomic?: boolean; borrowedFrom?: string | null; borrowedTerm?: string | null } | null;
  }>(
    `select resolved_value from contributions
      where word_id = $1 and submitted_by = $2 and axis = 'etymology' and status = 'active'
      order by submitted_at desc limit 1`,
    [wordId, userId],
  );
  const v = rows[0]?.resolved_value;
  if (!v) return null;
  const ids = v.components ?? [];
  const [held, requested] = await Promise.all([
    client.query<{ word_id: string; display_text: string; definition: string | null }>(
      'select word_id, display_text, definition from golden_record where word_id = any($1)',
      [ids],
    ),
    client.query<{ word_id: string; display_text: string; definition: string | null }>(
      `select distinct on (proposed_value ->> 'proposedWordId') proposed_value ->> 'proposedWordId' as word_id,
              proposed_value ->> 'displayText' as display_text, proposed_value ->> 'definition' as definition
         from contributions
        where axis = 'new_entry' and proposed_value ->> 'proposedWordId' = any($1)
        order by proposed_value ->> 'proposedWordId', submitted_at desc`,
      [ids],
    ),
  ]);
  const heldById = new Map(held.rows.map((r) => [r.word_id, r]));
  const requestedById = new Map(requested.rows.map((r) => [r.word_id, r]));
  const components = ids.map((id) => {
    const h = heldById.get(id);
    if (h) return { wordId: id, displayText: h.display_text, definition: h.definition, pending: false };
    const r = requestedById.get(id);
    return { wordId: id, displayText: r?.display_text ?? id, definition: r?.definition ?? null, pending: true };
  });
  // "No parts" arrives two ways - confirm_atomic, or rejecting a proposal on a word with nothing
  // recorded (an empty list) - and both say the same thing about the word.
  const atomic = v.atomic === true || ids.length === 0;
  const borrowing =
    v.borrowedFrom === undefined ? undefined : v.borrowedFrom ? { from: v.borrowedFrom, term: v.borrowedTerm ?? null } : null;
  const borrowingDiffers =
    borrowing !== undefined &&
    ((borrowing?.from ?? null) !== (recordBorrowing?.from ?? null) || (borrowing?.term ?? null) !== (recordBorrowing?.term ?? null));
  const differsFromRecord =
    borrowingDiffers ||
    atomic !== (recordComponents.length === 0) ||
    (!atomic && (ids.length !== recordComponents.length || ids.some((id, i) => id !== recordComponents[i])));
  return { atomic, components, differsFromRecord, ...(borrowing !== undefined ? { borrowing } : {}) };
}

/** The Wiktionary etymologies named as candidates for a proposal's parts, with whichever of our
 * words cites each. One round trip for all of them. */
async function loadPartCandidates(client: Queryable, entryIds: string[]): Promise<Map<string, WiktionaryPartCandidate>> {
  const out = new Map<string, WiktionaryPartCandidate>();
  if (entryIds.length === 0) return out;
  const { rows } = await client.query<{
    entry_id: string;
    canonical_value: string;
    pos: string | null;
    etymology_number: string | null;
    glosses: string[] | null;
    held_word_id: string | null;
    held_display_text: string | null;
  }>(
    `select distinct on (s.entry_id) s.entry_id, s.canonical_value, s.pos, s.etymology_number, s.glosses,
            g.word_id as held_word_id, g.display_text as held_display_text
       from kaikki_senses s
       left join upstream_citations c on c.entry_id = s.entry_id
       left join golden_record g on g.word_id = c.word_id
      where s.entry_id = any($1)
      order by s.entry_id, g.word_id`,
    [[...new Set(entryIds)]],
  );
  for (const r of rows) {
    out.set(r.entry_id, {
      entryId: r.entry_id,
      form: r.canonical_value,
      pos: r.pos ?? 'unknown',
      etymologyNumber: r.etymology_number,
      glosses: r.glosses ?? [],
      held: r.held_word_id ? { wordId: r.held_word_id, displayText: r.held_display_text ?? r.held_word_id } : null,
    });
  }
  return out;
}

export async function getEtymologyReview(client: Queryable, wordId: string, userId: string): Promise<EtymologyReviewResult> {
  const vocab = await loadVocab(client);
  const entry = vocab[wordId];
  if (!entry) {
    throw new WordNotFoundError(wordId);
  }
  const definition = await loadDefinition(client, wordId);
  const axisDecided = await loadAxisDecided(client, wordId, userId);
  const myProposedEntry = await loadMyEntryAnswer(client, wordId, userId);
  const borrowingRows = await client.query<{
    borrowed_from: string | null;
    borrowed_term: string | null;
    wik_from: string | null;
    wik_term: string | null;
  }>(
    `select g.borrowed_from, g.borrowed_term, s.borrowed_from as wik_from, s.borrowed_term as wik_term
       from golden_record g
       left join upstream_citations c on c.word_id = g.word_id
       left join kaikki_senses s on s.entry_id = c.entry_id
      where g.word_id = $1
      limit 1`,
    [wordId],
  );
  const b = borrowingRows.rows[0];
  const borrowing: Borrowing | null = b?.borrowed_from ? { from: b.borrowed_from, term: b.borrowed_term } : null;
  const wiktionaryBorrowing: Borrowing | null = b?.wik_from
    ? { from: normalizeLoanLanguage(b.wik_from), term: wiktionaryLoanTerm(b.wik_term) }
    : null;

  const key = orthographyInsensitiveForm(entry.displayText);
  const senses = await loadKaikkiSensesForKey(client, key);
  const lexicon = senses.length > 0 ? { [key]: senses } : {};
  const overrides = await loadSpellingConfirmedOverrides(client);

  const diagnosis = diagnoseEntry(wordId, entry, lexicon);
  const index = buildVocabSpellingIndex(vocab);
  const componentOwners = buildComponentOwnersIndex(vocab);

  const partCandidates = await loadPartCandidates(
    client,
    (diagnosis.matchedComponentCandidates ?? []).flatMap((c) => c.entryIds ?? []),
  );

  const fields = componentsAxisFields(
    wordId,
    vocab,
    diagnosis.matchedComponentCandidates,
    diagnosis.matchedUsedInCandidates,
    lexicon,
    overrides,
    index,
    componentOwners,
  );

  return {
    wordId,
    displayText: entry.displayText,
    syllables: entry.syllables,
    definition,
    entryType: entry.type === 'phrase' ? 'phrase' : null,
    axisDecided,
    myProposedEntry,
    myEtymologyAnswer: await loadMyEtymologyAnswer(
      client,
      wordId,
      userId,
      fields.components.length === 1 && fields.components[0] === wordId ? [] : fields.components,
      borrowing,
    ),
    borrowing,
    wiktionaryBorrowing,
    etymologyText: diagnosis.matchedEtymologyText ?? null,
    // Named, not spread: see the note on EtymologyReviewResult. usedInProposal and
    // usedAsComponentOf stop here.
    componentsProposal: fields.componentsProposal.map((item, i) => {
      // One proposal item per matched candidate, in order (componentsAxisFields maps them 1:1).
      const candidate = diagnosis.matchedComponentCandidates?.[i];
      return {
        ...item,
        possibleMatchWords: item.possibleMatches.map((id) => ({
          wordId: id,
          displayText: vocab[id]?.displayText ?? id,
          definition: vocab[id]?.definition ?? null,
        })),
        wiktionaryGloss: candidate?.gloss ?? null,
        wiktionaryCandidates: (candidate?.entryIds ?? [])
          .map((id) => partCandidates.get(id))
          .filter((c): c is WiktionaryPartCandidate => c !== undefined),
      };
    }),
    components: fields.components,
    // The self-reference is not a component; see the field's own note. vocab is already loaded, so
    // resolving each id to its spelling costs nothing extra.
    componentsOnRecord:
      fields.components.length === 1 && fields.components[0] === wordId
        ? []
        : fields.components.map((id) => ({
            wordId: id,
            displayText: vocab[id]?.displayText ?? id,
            definition: vocab[id]?.definition ?? null,
          })),
  };
}
