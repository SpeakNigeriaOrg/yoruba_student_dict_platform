// Since 0013 this handler does ONE thing: approve a 'new_entry' proposal.
//
// The entry and etymology cases that used to live here are gone, not moved -
// approving one volunteer's answer as the truth is no longer a coherent act
// when several people may have weighed in on the same word. Those axes are
// settled by confirmConsensus (see confirmConsensus.test.ts). What remains here
// is authorship: proposing a word that does not exist yet, which nobody else
// can have an opinion about because there is nothing there to have an opinion
// about.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import {
  approveContribution,
  ConsensusAxisNotIndividuallyApprovableError,
  ContributionAlreadyReviewedError,
  ContributionNotFoundError,
  LegacyAxisNotApprovableError,
} from './approveContribution.js';
import { submitContribution } from './submitContribution.js';
import { WordIdAlreadyExistsError } from './errors.js';

const NS = 'testapp_';
const pool = getTestPool();
let volunteerUserId: string;
let curatorUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const volunteer = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}volunteer@example.com`, 'Test Volunteer', 'volunteer'],
  );
  volunteerUserId = volunteer.rows[0].user_id;
  const curator = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}curator@example.com`, 'Test Curator', 'curator'],
  );
  curatorUserId = curator.rows[0].user_id;
  await pool.query(
    "insert into golden_record (word_id, display_text, syllables) values ($1, 'a', array['a']), ($2, 'b', array['b'])",
    [`${NS}comp_a`, `${NS}comp_b`],
  );
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

async function insertWord(wordId: string, definition: string | null = null): Promise<void> {
  await pool.query('insert into golden_record (word_id, display_text, syllables, definition) values ($1, $2, $3, $4)', [
    wordId,
    'x',
    ['x'],
    definition,
  ]);
}

describe('approveContribution', () => {
  describe('new_entry: authorship, still approved individually', () => {
    it('creates the golden_record row and marks the contribution applied', async () => {
      const wordId = `${NS}new_word`;
      const { contributionId } = await submitContribution(
        pool,
        { axis: 'new_entry', proposedValue: { proposedWordId: wordId, displayText: 'epo', syllables: ['e', 'po'], type: 'word' } },
        volunteerUserId,
      );

      await approveContribution(pool, contributionId, curatorUserId);

      const word = await pool.query<{ entry_type: string | null; updated_by: string }>(
        'select entry_type, updated_by from golden_record where word_id = $1',
        [wordId],
      );
      expect(word.rows[0]).toEqual({ entry_type: null, updated_by: curatorUserId });

      // 'applied', not 'approved' - 0013 replaced the verdict vocabulary, and
      // the check constraint no longer permits the old value at all.
      const row = await pool.query<{ status: string; reviewed_by: string }>(
        'select status, reviewed_by from contributions where contribution_id = $1',
        [contributionId],
      );
      expect(row.rows[0]).toEqual({ status: 'applied', reviewed_by: curatorUserId });
    });

    it('creates a phrase and its components in order', async () => {
      const wordId = `${NS}new_phrase`;
      const { contributionId } = await submitContribution(
        pool,
        {
          axis: 'new_entry',
          proposedValue: {
            proposedWordId: wordId,
            displayText: 'a b',
            syllables: ['a', 'b'],
            type: 'phrase',
            components: [`${NS}comp_a`, `${NS}comp_b`],
          },
        },
        volunteerUserId,
      );

      await approveContribution(pool, contributionId, curatorUserId);

      const rows = await pool.query<{ component_word_id: string }>(
        'select component_word_id from golden_record_components where word_id = $1 order by component_position',
        [wordId],
      );
      expect(rows.rows.map((r) => r.component_word_id)).toEqual([`${NS}comp_a`, `${NS}comp_b`]);
    });

    it('leaves the contribution untouched when a component does not exist', async () => {
      const wordId = `${NS}bad_phrase`;
      const { contributionId } = await submitContribution(
        pool,
        {
          axis: 'new_entry',
          proposedValue: {
            proposedWordId: wordId,
            displayText: 'a b',
            syllables: ['a', 'b'],
            type: 'phrase',
            components: [`${NS}nonexistent`],
          },
        },
        volunteerUserId,
      );

      await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toThrow();

      const created = await pool.query('select 1 from golden_record where word_id = $1', [wordId]);
      expect(created.rowCount).toBe(0);
      const row = await pool.query<{ status: string }>('select status from contributions where contribution_id = $1', [
        contributionId,
      ]);
      expect(row.rows[0].status).toBe('active');
    });

    it('refuses when the proposed word_id already exists', async () => {
      const wordId = `${NS}dupe_word`;
      await insertWord(wordId);
      const { contributionId } = await submitContribution(
        pool,
        { axis: 'new_entry', proposedValue: { proposedWordId: wordId, displayText: 'x', syllables: ['x'], type: 'word' } },
        volunteerUserId,
      );

      await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toThrow(WordIdAlreadyExistsError);
    });

    it('refuses to approve the same proposal twice', async () => {
      const wordId = `${NS}reapprove_word`;
      const { contributionId } = await submitContribution(
        pool,
        { axis: 'new_entry', proposedValue: { proposedWordId: wordId, displayText: 'x', syllables: ['x'], type: 'word' } },
        volunteerUserId,
      );

      await approveContribution(pool, contributionId, curatorUserId);
      await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toThrow(ContributionAlreadyReviewedError);
    });
  });

  describe('consensus axes are no longer individually approvable', () => {
    it('refuses an entry contribution, pointing at the consensus path', async () => {
      // The behaviour change at the heart of the phase: applying one
      // volunteer's answer would ignore everyone else who weighed in.
      const wordId = `${NS}entry_word`;
      await insertWord(wordId);
      const { contributionId } = await submitContribution(
        pool,
        { axis: 'entry', wordId, proposedValue: { action: 'keep_ours', definitionAction: 'confirm' } },
        volunteerUserId,
      );

      await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toBeInstanceOf(
        ConsensusAxisNotIndividuallyApprovableError,
      );
      await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toThrow(/consensus/);

      // Nothing applied, and the contribution is still live evidence.
      const decisions = await pool.query('select 1 from word_decisions where word_id = $1', [wordId]);
      expect(decisions.rowCount).toBe(0);
      const row = await pool.query<{ status: string }>('select status from contributions where contribution_id = $1', [
        contributionId,
      ]);
      expect(row.rows[0].status).toBe('active');
    });

    it('refuses an etymology contribution', async () => {
      const wordId = `${NS}etym_word`;
      await insertWord(wordId);
      const { contributionId } = await submitContribution(
        pool,
        {
          axis: 'etymology',
          wordId,
          proposedValue: { componentsAction: 'accept_proposed', components: [`${NS}comp_a`, `${NS}comp_b`] },
        },
        volunteerUserId,
      );

      await expect(approveContribution(pool, contributionId, curatorUserId)).rejects.toBeInstanceOf(
        ConsensusAxisNotIndividuallyApprovableError,
      );
      const components = await pool.query('select 1 from golden_record_components where word_id = $1', [wordId]);
      expect(components.rowCount).toBe(0);
    });

    it('refuses a pre-merge spelling/definition contribution', async () => {
      // Those axis values survive on historical rows (0011 kept them readable);
      // they are unapprovable, and must fail loudly rather than being marked
      // applied while applying nothing.
      const wordId = `${NS}legacy_word`;
      await insertWord(wordId);
      const inserted = await pool.query<{ contribution_id: string }>(
        `insert into contributions (word_id, axis, proposed_value, submitted_by)
         values ($1, 'spelling', '{"action":"keep_ours"}'::jsonb, $2) returning contribution_id`,
        [wordId, volunteerUserId],
      );

      await expect(approveContribution(pool, inserted.rows[0].contribution_id, curatorUserId)).rejects.toBeInstanceOf(
        LegacyAxisNotApprovableError,
      );
    });
  });

  it('rejects approving a contribution id that does not exist', async () => {
    await expect(approveContribution(pool, '00000000-0000-0000-0000-000000000000', curatorUserId)).rejects.toThrow(
      ContributionNotFoundError,
    );
  });
});
