import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanUpTestData, getTestPool } from '../testSupport.js';
import { listContributions } from './listContributions.js';
import { submitContribution } from './submitContribution.js';

const NS = 'testlistcontrib_';
const pool = getTestPool();
let volunteerUserId: string;

beforeAll(async () => {
  await cleanUpTestData(pool, NS);
  const volunteer = await pool.query<{ user_id: string }>(
    'insert into users (email, display_name, role) values ($1, $2, $3) returning user_id',
    [`${NS}volunteer`, 'Test Volunteer', 'volunteer'],
  );
  volunteerUserId = volunteer.rows[0].user_id;
});

afterAll(async () => {
  await cleanUpTestData(pool, NS);
  await pool.end();
});

describe('listContributions', () => {
  it('lists a real pending contribution with word/submitter context', async () => {
    const wordId = `${NS}pending_word`;
    await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
      wordId, `${NS}pendingspelling`, [`${NS}pendingspelling`],
    ]);
    await submitContribution(
      pool,
      { axis: 'entry', wordId, proposedValue: { action: 'keep_ours', definitionAction: 'custom', definitionText: 'proposed text' }, note: 'a note' },
      volunteerUserId,
    );

    const contributions = await listContributions(pool, 'active');
    const found = contributions.find((c) => c.wordId === wordId);

    expect(found).toBeDefined();
    expect(found?.wordDisplayText).toBe(`${NS}pendingspelling`);
    expect(found?.axis).toBe('entry');
    expect(found?.submittedBy).toBe(`${NS}volunteer`);
    expect(found?.note).toBe('a note');
    expect(found?.status).toBe('active');
  });

  it('drops an excluded contribution from the default filter but keeps it findable', async () => {
    // Exclusion sets a row aside from the tally without deleting the belief, so
    // it must still be retrievable under its own status.
    const result = await submitContribution(
      pool,
      { axis: 'new_entry', proposedValue: { proposedWordId: `${NS}newentryword`, displayText: 'x', syllables: ['x'], type: 'word' } },
      volunteerUserId,
    );
    await pool.query("update contributions set status = 'excluded' where contribution_id = $1", [result.contributionId]);

    const active = await listContributions(pool, 'active');
    expect(active.find((c) => c.contributionId === result.contributionId)).toBeUndefined();

    const excluded = await listContributions(pool, 'excluded');
    expect(excluded.find((c) => c.contributionId === result.contributionId)).toBeDefined();
  });

  describe('what is waiting on a requested word', () => {
    it('names the words whose etymology submissions reference it', async () => {
      // The ordering constraint - approve the word, THEN confirm the etymology naming it - is
      // enforced by ComponentsNotFoundError, but a curator used to meet it as a failure at
      // confirmation time with nothing to see beforehand. This is what makes it legible.
      const compound = `${NS}waiting_compound`;
      await pool.query('insert into golden_record (word_id, display_text, syllables) values ($1, $2, $3)', [
        compound,
        `${NS}waitingspelling`,
        ['zq'],
      ]);
      const request = await submitContribution(
        pool,
        {
          axis: 'new_entry',
          proposedValue: {
            proposedWordId: `${NS}requested_part`,
            displayText: 'zqpart',
            syllables: ['zq'],
            type: 'word',
            citation: { exemptReason: 'test request' },
          },
        },
        volunteerUserId,
      );
      await submitContribution(
        pool,
        { axis: 'etymology', wordId: compound, proposedValue: { componentsAction: 'custom', components: [`${NS}requested_part`] } },
        volunteerUserId,
      );

      const found = (await listContributions(pool, 'active')).find((c) => c.contributionId === request.contributionId);
      expect(found?.waitingWords).toEqual([{ wordId: compound, displayText: `${NS}waitingspelling` }]);
    });

    it('is empty for a request nothing references, and for every other axis', async () => {
      const request = await submitContribution(
        pool,
        {
          axis: 'new_entry',
          proposedValue: {
            proposedWordId: `${NS}unwanted_part`,
            displayText: 'zqother',
            syllables: ['zq'],
            type: 'word',
            citation: { exemptReason: 'test request' },
          },
        },
        volunteerUserId,
      );

      const all = await listContributions(pool, 'active');
      expect(all.find((c) => c.contributionId === request.contributionId)?.waitingWords).toEqual([]);
      // Not just absent on other axes - present and empty, so the UI needs no null check.
      for (const item of all.filter((c) => c.axis !== 'new_entry')) {
        expect(item.waitingWords).toEqual([]);
      }
    });
  });
});
