// Turning "the part I mean is this Wiktionary etymology" into a component word_id.
//
// The test that matters most is the last one: approving the request creates the word at exactly
// the planned id, so an etymology decision naming it CONFIRMS where it previously raised
// ComponentsNotFoundError. That is the flow-back, exercised rather than asserted.
//
// Every display text here begins with the file's namespace, so the ids this handler DERIVES
// (rather than the ones the test writes) still land inside the prefix cleanUpTestData scopes to.
// A derived id is not under the test's control, and a leaked `wohun_a_new_thing` in a shared
// database is exactly the kind of leftover the namespace scheme exists to prevent.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanUpTestData, deleteTestKaikkiSenses, getTestPool, insertTestKaikkiSense } from '../testSupport.js';
import {
  DefinitionRequiredError,
  DisplayTextRequiredError,
  NO_UPSTREAM_ENTRY_REASON,
  requestUnlistedComponent,
  resolveOrRequestComponent,
  WordAlreadyInDictionaryError,
} from './resolveOrRequestComponent.js';
import { approveContribution } from './approveContribution.js';
import { applyEtymologyDecision, ComponentsNotFoundError } from './applyEtymologyDecision.js';
import {
  EntryIdNotCitableError,
  EntryIdNotInCorpusError,
  writeCitationInTransaction,
} from './upstreamCitations.js';

const NS = 'testroq_';
const ENTRY_NS = 'testroq-entry-';
const pool = getTestPool();
let ada: string;
let ben: string;
let curator: string;

/** Everything the namespace owns except its users, which the tests share. */
async function resetData(): Promise<void> {
  await pool.query('delete from golden_record_components where word_id like $1 or component_word_id like $1', [
    `${NS.replace('_', '\\_')}%`,
  ]);
  await pool.query('delete from contributions where submitted_by = any($1) or reviewed_by = any($1)', [
    [ada, ben, curator].filter(Boolean),
  ]);
  await pool.query('delete from golden_record where word_id like $1', [`${NS.replace('_', '\\_')}%`]);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
}

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  await deleteTestKaikkiSenses(pool, ENTRY_NS);
  const mk = async (name: string, role: 'curator' | 'volunteer') =>
    (
      await pool.query<{ user_id: string }>(
        'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
        [`${NS}${name}@example.com`, name, role],
      )
    ).rows[0].user_id;
  ada = await mk('ada', 'volunteer');
  ben = await mk('ben', 'volunteer');
  curator = await mk('curator', 'curator');
});

beforeEach(resetData);

afterAll(async () => {
  await resetData();
  await cleanUpTestData(pool, NS);
  await pool.end();
});

/** A corpus etymology to point at. The form carries tone marks and an underdot so the derived id
 * exercises the same stripping production's own ids were built with. */
async function corpusEntry(suffix: string, form: string, gloss: string): Promise<string> {
  const entryId = `${ENTRY_NS}${suffix}`;
  await insertTestKaikkiSense(pool, {
    entryId,
    headword: form,
    canonicalValue: form,
    pos: 'noun',
    etymologyNumber: '1',
    glosses: [gloss],
  });
  return entryId;
}

async function citedWord(wordId: string, displayText: string, entryId: string): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
    wordId,
    displayText,
    ['zq'],
  ]);
  await writeCitationInTransaction(pool, wordId, { entryId }, curator);
}

describe('resolving to a word we already hold', () => {
  it('returns the existing word and creates NO request', async () => {
    // Resolution is by CITATION, not by re-deriving an id: production's 92 words carry
    // hand-made ids (`agunfon_giraffe`) that predate this derivation, and picking the etymology
    // one of them cites has to find that word rather than request a duplicate. So the word here
    // deliberately sits at an id the derivation would never produce.
    const entryId = await corpusEntry('held', `${NS}dùjẹ̀kù`, 'a held thing');
    await citedWord(`${NS}handmade_id`, `${NS}dùjẹ̀kù`, entryId);

    const before = await pool.query<{ n: number }>('select count(*)::int n from contributions');
    const result = await resolveOrRequestComponent(pool, entryId, ada);
    const after = await pool.query<{ n: number }>('select count(*)::int n from contributions');

    expect(result).toMatchObject({ outcome: 'resolved', wordId: `${NS}handmade_id` });
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('requesting a word we do not hold', () => {
  it('creates one new_entry carrying the citation, definition and syllables', async () => {
    const entryId = await corpusEntry('newone', `${NS}wòhún`, 'a new thing');
    const result = await resolveOrRequestComponent(pool, entryId, ada);

    expect(result.outcome).toBe('requested');
    // Tone marks stripped, meaning slugged - production's own convention (ewa_beans / ewa_beauty).
    expect(result.wordId).toBe(`${NS}wohun_a_new_thing`);

    const { rows } = await pool.query<{ proposed_value: Record<string, unknown>; status: string; axis: string }>(
      'select proposed_value, status, axis from contributions where contribution_id = $1',
      [result.contributionId],
    );
    expect(rows[0].axis).toBe('new_entry');
    expect(rows[0].status).toBe('active');
    expect(rows[0].proposed_value).toMatchObject({
      proposedWordId: `${NS}wohun_a_new_thing`,
      // The SPELLING is preserved even though the id strips it. The id is a key; this is the word.
      displayText: `${NS}wòhún`,
      // Without this the approved word would arrive meaningless - the one thing a curator most
      // needs for a word nobody has seen before.
      definition: 'a new thing',
      type: 'word',
      citation: { entryId },
    });
    expect((rows[0].proposed_value as { syllables: string[] }).syllables.length).toBeGreaterThan(0);
  });

  it('returns the SAME planned id to a second volunteer, rather than requesting twice', async () => {
    // Two volunteers naming the same missing part must agree, because agreement is exactly what
    // the consensus tally compares on the etymology axis. A per-caller id would score two people
    // who agree as being in conflict.
    const entryId = await corpusEntry('shared', `${NS}tẹ̀rùkó`, 'a shared thing');
    const first = await resolveOrRequestComponent(pool, entryId, ada);
    const second = await resolveOrRequestComponent(pool, entryId, ben);

    expect(first.outcome).toBe('requested');
    expect(second.outcome).toBe('already_requested');
    expect(second.wordId).toBe(first.wordId);
    expect(second.contributionId).toBe(first.contributionId);

    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int n from contributions
       where axis = 'new_entry' and proposed_value -> 'citation' ->> 'entryId' = $1`,
      [entryId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('discriminates the id when it is taken by a word citing a DIFFERENT etymology', async () => {
    // A genuine collision: same stripped spelling, same first gloss, different etymology. ~2% of
    // the corpus can do this, and pointing at the wrong word would be silent and wrong.
    const held = await corpusEntry('collide_a', `${NS}gbẹ̀dùjó`, 'same gloss');
    const other = await corpusEntry('collide_b', `${NS}gbedujo`, 'same gloss');
    const taken = `${NS}gbedujo_same_gloss`;
    await citedWord(taken, `${NS}gbẹ̀dùjó`, held);

    const result = await resolveOrRequestComponent(pool, other, ada);
    expect(result.outcome).toBe('requested');
    expect(result.wordId).not.toBe(taken);
    expect(result.wordId.startsWith(`${taken}_`)).toBe(true);
  });

  it('does not hand two DIFFERENT etymologies the same id just because neither is approved yet', async () => {
    // Found by verifying the derivation against production: 262 corpus entries (4.2%) share a
    // derived id with another entry. Checking only golden_record, two volunteers requesting two
    // of those before either is approved would BOTH be told the base id is free - two etymologies
    // queued under one word_id, and a component reference that no longer says which was meant.
    const first = await corpusEntry('pending_a', `${NS}gbẹ̀dùjó`, 'same gloss');
    const second = await corpusEntry('pending_b', `${NS}gbedujo`, 'same gloss');

    const a = await resolveOrRequestComponent(pool, first, ada);
    const b = await resolveOrRequestComponent(pool, second, ben);

    expect(a.outcome).toBe('requested');
    expect(b.outcome).toBe('requested');
    expect(b.wordId).not.toBe(a.wordId);
  });

  it('separates a case pair, which the entry-id token alone cannot', async () => {
    // 63 of those 262 entries share the entry-id token too: they are case pairs like `a`/`A`,
    // whose ids differ only in a character discriminateWordId lowercases away. Without a third
    // rung both would land on the same discriminated id.
    const lower = `${ENTRY_NS}case-yo-pron-ABC`;
    const upper = `${ENTRY_NS}CASE-yo-pron-ABC`;
    for (const [entryId, form] of [
      [lower, `${NS}gbedujo`],
      [upper, `${NS}Gbedujo`],
    ] as const) {
      await insertTestKaikkiSense(pool, {
        entryId,
        headword: form,
        canonicalValue: form,
        pos: 'pron',
        etymologyNumber: '1',
        glosses: ['same gloss'],
      });
    }
    // A word already holds the base id, so both requests must discriminate.
    await citedWord(`${NS}gbedujo_same_gloss`, `${NS}gbedujo`, await corpusEntry('case_held', `${NS}gbẹ̀dùjó`, 'same gloss'));

    const a = await resolveOrRequestComponent(pool, lower, ada);
    const b = await resolveOrRequestComponent(pool, upper, ben);

    expect(a.wordId).not.toBe(`${NS}gbedujo_same_gloss`);
    expect(b.wordId).not.toBe(`${NS}gbedujo_same_gloss`);
    expect(b.wordId).not.toBe(a.wordId);
  });

  it('derives the same discriminated id for a second volunteer', async () => {
    // Determinism has to survive the collision path too, or the 2% would be the cases where
    // consensus quietly stops working.
    const held = await corpusEntry('collide2_a', `${NS}gbẹ̀dùjó`, 'same gloss');
    const other = await corpusEntry('collide2_b', `${NS}gbedujo`, 'same gloss');
    await citedWord(`${NS}gbedujo_same_gloss`, `${NS}gbẹ̀dùjó`, held);

    const first = await resolveOrRequestComponent(pool, other, ada);
    const second = await resolveOrRequestComponent(pool, other, ben);
    expect(second.wordId).toBe(first.wordId);
  });

  it('refuses a generated- entry id, which tracks ingest order rather than an etymology', async () => {
    await expect(resolveOrRequestComponent(pool, 'generated-zq-noun-1', ada)).rejects.toThrow(EntryIdNotCitableError);
  });

  it('refuses an entry id absent from the corpus', async () => {
    await expect(resolveOrRequestComponent(pool, `${ENTRY_NS}nonexistent`, ada)).rejects.toThrow(
      EntryIdNotInCorpusError,
    );
  });
});

describe('a word Wiktionary does not have either', () => {
  it('records the request as citation-EXEMPT, which is also the record that it awaits an entry', async () => {
    const result = await requestUnlistedComponent(
      pool,
      { displayText: `${NS}wòhún`, definition: 'a word Wiktionary lacks' },
      ada,
    );

    expect(result).toMatchObject({ outcome: 'requested', wordId: `${NS}wohun_a_word_wiktionary_lacks` });
    const { rows } = await pool.query<{ proposed_value: Record<string, unknown> }>(
      'select proposed_value from contributions where contribution_id = $1',
      [result.contributionId],
    );
    expect(rows[0].proposed_value).toMatchObject({
      displayText: `${NS}wòhún`,
      definition: 'a word Wiktionary lacks',
      // Not a missing citation - an explicit one. 0014's check constraint makes "no
      // upstream_citations row" mean exactly one thing (not done), so an exempt reason is how a
      // word with no upstream entry is stored, and what makes it findable later.
      citation: { exemptReason: NO_UPSTREAM_ENTRY_REASON },
    });
  });

  it('normalises the spelling to NFC, so the same word written two ways is one request', async () => {
    // The composer's tone grid emits NFC, but a pasted spelling can be NFD. Both derive the same
    // id (orthographyInsensitiveForm strips marks either way) - what would differ is the stored
    // display_text, i.e. two spellings of one word.
    const nfd = `${NS}wòhún`.normalize('NFD');
    expect(nfd).not.toBe(`${NS}wòhún`);
    const result = await requestUnlistedComponent(pool, { displayText: nfd, definition: 'nfd spelling' }, ada);

    const { rows } = await pool.query<{ proposed_value: { displayText: string } }>(
      'select proposed_value from contributions where contribution_id = $1',
      [result.contributionId],
    );
    expect(rows[0].proposed_value.displayText).toBe(`${NS}wòhún`);
  });

  it('returns the SAME request to a second volunteer who writes the same word and meaning', async () => {
    const first = await requestUnlistedComponent(pool, { displayText: `${NS}bàdù`, definition: 'a shared word' }, ada);
    const second = await requestUnlistedComponent(pool, { displayText: `${NS}bàdù`, definition: 'a shared word' }, ben);

    expect(second.outcome).toBe('already_requested');
    expect(second.contributionId).toBe(first.contributionId);
  });

  it('refuses when the dictionary already holds that spelling and meaning, rather than guessing', async () => {
    // No etymology to tell two entries apart here, so a collision means it is almost certainly
    // the word we already hold. Discriminating into a second id would silently duplicate it.
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      `${NS}badu_a_held_word`,
      `${NS}bàdù`,
      ['zq'],
    ]);
    await expect(
      requestUnlistedComponent(pool, { displayText: `${NS}bàdù`, definition: 'a held word' }, ada),
    ).rejects.toThrow(WordAlreadyInDictionaryError);
  });

  it('requires the word and its definition', async () => {
    await expect(requestUnlistedComponent(pool, { displayText: '  ', definition: 'x' }, ada)).rejects.toThrow(
      DisplayTextRequiredError,
    );
    // A word with no meaning cannot be reviewed, so it must not reach the queue as one.
    await expect(
      requestUnlistedComponent(pool, { displayText: `${NS}bàdù`, definition: '  ' }, ada),
    ).rejects.toThrow(DefinitionRequiredError);
  });

  it('approving it creates the word with its exempt citation, so it is findable as awaiting upstream', async () => {
    const request = await requestUnlistedComponent(
      pool,
      { displayText: `${NS}bàdù`, definition: 'an unlisted word' },
      ada,
    );
    await approveContribution(pool, request.contributionId!, curator);

    const { rows } = await pool.query<{ entry_id: string | null; exempt_reason: string | null }>(
      'select entry_id, exempt_reason from upstream_citations where word_id = $1',
      [request.wordId],
    );
    expect(rows[0].entry_id).toBeNull();
    expect(rows[0].exempt_reason).toBe(NO_UPSTREAM_ENTRY_REASON);
  });
});

describe('the flow-back: approving the request resolves the dangling reference', () => {
  it('an etymology naming a requested word is refused BEFORE approval and confirms after', async () => {
    const compoundEntry = await corpusEntry('compound', `${NS}gbẹ̀dù jó`, 'a compound');
    await citedWord(`${NS}compound`, `${NS}gbẹ̀dù jó`, compoundEntry);
    const partEntry = await corpusEntry('part', `${NS}bàdù`, 'a part');

    // A volunteer names a component we do not hold. They finish their task now, not later.
    const request = await resolveOrRequestComponent(pool, partEntry, ada);
    expect(request.outcome).toBe('requested');
    expect(request.wordId).toBe(`${NS}badu_a_part`);

    // Confirming the etymology is refused while the part is still only requested, and says which
    // one - the ordering constraint is enforced by existing code, not by hope.
    await expect(
      applyEtymologyDecision(
        pool,
        `${NS}compound`,
        { componentsAction: 'custom', components: [request.wordId] },
        curator,
      ),
    ).rejects.toThrow(ComponentsNotFoundError);

    // The curator approves the request. No rewriting, no reconciliation pass.
    await approveContribution(pool, request.contributionId!, curator);

    const created = await pool.query<{ display_text: string; definition: string | null }>(
      'select display_text, definition from golden_record where word_id = $1',
      [request.wordId],
    );
    expect(created.rows[0]).toMatchObject({ display_text: `${NS}bàdù`, definition: 'a part' });

    // And the same decision now confirms, against the id the volunteer already submitted.
    await applyEtymologyDecision(
      pool,
      `${NS}compound`,
      { componentsAction: 'custom', components: [request.wordId] },
      curator,
    );
    const components = await pool.query<{ component_word_id: string }>(
      'select component_word_id from golden_record_components where word_id = $1 order by component_position',
      [`${NS}compound`],
    );
    expect(components.rows.map((r) => r.component_word_id)).toEqual([request.wordId]);
  });

  it('the approved word carries its citation, so it is a proper entry and not a stub', async () => {
    const partEntry = await corpusEntry('cited_part', `${NS}bàdù`, 'a cited part');
    const request = await resolveOrRequestComponent(pool, partEntry, ada);
    await approveContribution(pool, request.contributionId!, curator);

    const { rows } = await pool.query<{ entry_id: string; pin: { glosses?: string[] } }>(
      'select entry_id, pin from upstream_citations where word_id = $1',
      [request.wordId],
    );
    expect(rows[0].entry_id).toBe(partEntry);
    expect(rows[0].pin.glosses).toEqual(['a cited part']);
  });
});
