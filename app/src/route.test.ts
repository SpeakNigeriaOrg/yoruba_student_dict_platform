import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, formatRoute, parseHash, sameRoute, type Route } from './route.js';

describe('parseHash', () => {
  it('falls back to the queue for an empty or bare hash', () => {
    expect(parseHash('')).toEqual({ view: 'queue' });
    expect(parseHash('#')).toEqual({ view: 'queue' });
    expect(parseHash('#/')).toEqual({ view: 'queue' });
  });

  it('falls back to the queue rather than a blank screen for anything unrecognised', () => {
    // A typo, a hand-edited URL, or a link from an older build that used
    // #/spelling - none of these should render nothing.
    expect(parseHash('#/nope')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/spelling')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/word')).toEqual(DEFAULT_ROUTE);
  });

  it('parses the flat curator views', () => {
    expect(parseHash('#/queue')).toEqual({ view: 'queue' });
    expect(parseHash('#/add')).toEqual({ view: 'add' });
    expect(parseHash('#/users')).toEqual({ view: 'users' });
  });

  it('parses the curating surface and defaults it to the overview', () => {
    expect(parseHash('#/dictionary')).toEqual({ view: 'dictionary', tab: 'overview' });
    expect(parseHash('#/dictionary/words')).toEqual({ view: 'dictionary', tab: 'words' });
    expect(parseHash('#/dictionary/decisions')).toEqual({ view: 'dictionary', tab: 'decisions' });
    expect(parseHash('#/dictionary/rights')).toEqual({ view: 'dictionary', tab: 'rights' });
    expect(parseHash('#/dictionary/nonsense')).toEqual({ view: 'dictionary', tab: 'overview' });
  });

  it('parses a dossier route, and refuses one with no word', () => {
    expect(parseHash('#/dossier/owo_hand')).toEqual({ view: 'dossier', wordId: 'owo_hand' });
    expect(parseHash('#/dossier')).toEqual(DEFAULT_ROUTE);
  });

  it('lands an old browse or contributions link on the view that replaced it', () => {
    // Both were folded into the dictionary surface. Silently dropping a bookmark on the
    // queue would look like the app losing its place.
    expect(parseHash('#/browse')).toEqual({ view: 'dictionary', tab: 'words' });
    expect(parseHash('#/contributions')).toEqual({ view: 'dictionary', tab: 'decisions' });
  });

  it('parses a user detail route', () => {
    expect(parseHash('#/users/abc-123')).toEqual({ view: 'user', userId: 'abc-123' });
  });

  it("parses one person's contribution, and falls back to their page without an id", () => {
    expect(parseHash('#/users/abc-123/contribution/c-9')).toEqual({
      view: 'contribution',
      userId: 'abc-123',
      contributionId: 'c-9',
    });
    // Nested under the user on purpose, so a truncated URL lands on the person rather than
    // on the queue - and so Back from a contribution goes to whose page it was.
    expect(parseHash('#/users/abc-123/contribution')).toEqual({ view: 'user', userId: 'abc-123' });
    // An unknown third segment is not a contribution route and must not silently read as one.
    expect(parseHash('#/users/abc-123/nonsense')).toEqual({ view: 'user', userId: 'abc-123' });
  });

  it('parses a word route, defaulting to the entry axis', () => {
    expect(parseHash('#/word/epo_oil')).toEqual({ view: 'word', wordId: 'epo_oil', axis: 'entry' });
    expect(parseHash('#/word/epo_oil/etymology')).toEqual({ view: 'word', wordId: 'epo_oil', axis: 'etymology' });
    expect(parseHash('#/word/epo_oil/audio')).toEqual({ view: 'word', wordId: 'epo_oil', axis: 'audio' });
  });

  it('falls back to the entry axis for a retired or unknown axis segment', () => {
    // 'spelling'/'definition' were real axes before the entry merge, so old
    // bookmarks and shared links carry them.
    expect(parseHash('#/word/epo_oil/spelling')).toEqual({ view: 'word', wordId: 'epo_oil', axis: 'entry' });
    expect(parseHash('#/word/epo_oil/definition')).toEqual({ view: 'word', wordId: 'epo_oil', axis: 'entry' });
    expect(parseHash('#/word/epo_oil/gibberish')).toEqual({ view: 'word', wordId: 'epo_oil', axis: 'entry' });
  });

  it('decodes percent-encoded ids', () => {
    expect(parseHash('#/word/a%2Fb/entry')).toEqual({ view: 'word', wordId: 'a/b', axis: 'entry' });
    expect(parseHash('#/users/a%20b')).toEqual({ view: 'user', userId: 'a b' });
  });

  it('tolerates a missing leading slash', () => {
    expect(parseHash('#queue')).toEqual({ view: 'queue' });
  });
});

describe('formatRoute', () => {
  it('round-trips every route shape', () => {
    const routes: Route[] = [
      { view: 'queue' },
      { view: 'add' },
      { view: 'users' },
      { view: 'dictionary', tab: 'overview' },
      { view: 'dictionary', tab: 'words' },
      { view: 'dictionary', tab: 'decisions' },
      { view: 'dictionary', tab: 'rights' },
      { view: 'dossier', wordId: 'epo_oil' },
      { view: 'user', userId: 'abc-123' },
      { view: 'contribution', userId: 'abc-123', contributionId: 'c-9' },
      { view: 'word', wordId: 'epo_oil', axis: 'entry' },
      { view: 'word', wordId: 'epo_oil', axis: 'etymology' },
      { view: 'word', wordId: 'epo_oil', axis: 'audio' },
    ];
    for (const route of routes) {
      expect(parseHash(formatRoute(route))).toEqual(route);
    }
  });

  it('escapes ids that would otherwise break the path', () => {
    const route: Route = { view: 'word', wordId: 'a/b', axis: 'entry' };
    expect(formatRoute(route)).toBe('#/word/a%2Fb/entry');
    expect(parseHash(formatRoute(route))).toEqual(route);
  });
});

describe('sameRoute', () => {
  it('compares by resulting href, not object identity', () => {
    expect(sameRoute({ view: 'queue' }, { view: 'queue' })).toBe(true);
    expect(sameRoute({ view: 'user', userId: 'a' }, { view: 'user', userId: 'a' })).toBe(true);
    expect(sameRoute({ view: 'user', userId: 'a' }, { view: 'user', userId: 'b' })).toBe(false);
    expect(
      sameRoute({ view: 'word', wordId: 'w', axis: 'entry' }, { view: 'word', wordId: 'w', axis: 'audio' }),
    ).toBe(false);
  });
});
