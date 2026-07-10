import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyToneMatch, type ToneMatchStatus } from './toneMatching';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

interface ClassifyToneMatchFixture {
  name: string;
  ourText: string;
  theirText: string;
  expectedStatus: ToneMatchStatus;
}

const fixtures: ClassifyToneMatchFixture[] = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, 'classify_tone_match.json'), 'utf8'),
);

describe('classifyToneMatch (parity with generate_diagnostics.py, via real fixtures)', () => {
  it('has fixtures to test against', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: ${JSON.stringify(fixture.ourText)} vs ${JSON.stringify(fixture.theirText)} -> ${fixture.expectedStatus}`, () => {
      expect(classifyToneMatch(fixture.ourText, fixture.theirText)).toBe(fixture.expectedStatus);
    });
  }

  // Spelled out explicitly (already covered by the fixture loop above) so
  // the specific bug this distinction fixes doesn't get lost in a generic
  // parametrized loop - see REMOTE_ACCESS_DISCUSSION.md §4.
  it('treats owó (money) vs ọwọ́ (hand) as underdot_mismatch, never a silent match', () => {
    expect(classifyToneMatch('owó', 'ọwọ́')).toBe('underdot_mismatch');
  });

  it('treats ìlẹ̀ (ground) vs ilé (home) as underdot_mismatch, never a silent match', () => {
    expect(classifyToneMatch('ìlẹ̀', 'ilé')).toBe('underdot_mismatch');
  });
});
