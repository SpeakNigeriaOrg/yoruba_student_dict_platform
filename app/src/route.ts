// route.ts
//
// Hash-based routing. Deliberately hand-written rather than pulling in
// react-router: app/package.json has exactly three runtime dependencies
// (react, react-dom, shared) and that is worth keeping, and the whole
// surface here is seven routes with at most one parameter each.
//
// This exists because the app previously held all navigation in local state
// (App.tsx's selectedWordId/mainView/selectedAxis), which had three real
// consequences on a phone:
//
//   1. No history entries were ever pushed, so Android's back gesture and
//      iOS Safari's swipe-back left the SPA entirely rather than going back
//      one screen. That is the single worst navigation defect for a
//      volunteer working through a queue.
//   2. A refresh dropped you back to the start.
//   3. Two independent nav stacks existed - App.tsx's selectedWordId and
//      AdminUsers.tsx's own selectedUserId - so Users -> a user -> a word ->
//      Back re-mounted AdminUsers fresh and landed on the user LIST, not the
//      user you had been inside. One route means one stack.
//
// parse/format are pure and exported separately from the hook so they can be
// tested without a DOM.

export type Axis = 'entry' | 'etymology' | 'audio' | 'example';

export const AXES: readonly Axis[] = ['entry', 'etymology', 'audio', 'example'];

/** Which view of the curating surface is open.
 *
 * One surface with three views rather than three tabs, because they are three questions
 * about one thing: the survey is the spine, the overview summarises it, and the decision
 * queues are filters over it. 'browse' and 'contributions' were separate tabs saying the
 * same thing twice. */
export type DictionaryView = 'overview' | 'words' | 'decisions' | 'coverage' | 'rights';

export const DICTIONARY_VIEWS: readonly DictionaryView[] = ['overview', 'words', 'decisions', 'coverage', 'rights'];

export type Route =
  | { view: 'queue' }
  | { view: 'add' }
  | { view: 'users' }
  | { view: 'user'; userId: string }
  | { view: 'word'; wordId: string; axis: Axis }
  /** The curating surface. */
  | { view: 'dictionary'; tab: DictionaryView }
  /** Everything held about one word - the deep view, distinct from working ON the word. */
  | { view: 'dossier'; wordId: string }
  /** What ONE person contributed, read-only. Nested under the user rather than the word
   * because that is where it is reached from and what it is about - and because a
   * 'new_entry' proposal has no word to nest under at all. */
  | { view: 'contribution'; userId: string; contributionId: string };

export const DEFAULT_ROUTE: Route = { view: 'queue' };

function isAxis(value: string): value is Axis {
  return (AXES as readonly string[]).includes(value);
}

function isDictionaryView(value: string): value is DictionaryView {
  return (DICTIONARY_VIEWS as readonly string[]).includes(value);
}

/** Parses a location.hash into a Route. Anything unrecognised - an empty
 * hash, a typo, a hand-edited URL, a link from an older build - resolves to
 * the queue rather than a blank screen. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const segments = raw
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeURIComponent);

  if (segments.length === 0) return DEFAULT_ROUTE;

  switch (segments[0]) {
    case 'queue':
      return { view: 'queue' };
    case 'add':
      return { view: 'add' };
    case 'dictionary': {
      const tab = segments[1];
      return { view: 'dictionary', tab: tab && isDictionaryView(tab) ? tab : 'overview' };
    }
    case 'dossier':
      return segments[1] ? { view: 'dossier', wordId: segments[1] } : DEFAULT_ROUTE;
    // Kept so a bookmark or a link from an older build still lands somewhere sensible
    // rather than silently on the queue - both were folded into the dictionary surface.
    case 'browse':
      return { view: 'dictionary', tab: 'words' };
    case 'contributions':
      return { view: 'dictionary', tab: 'decisions' };
    case 'users':
      // #/users and #/users/{id} are the same stack, which is what collapses
      // AdminUsers' former private selectedUserId state.
      if (!segments[1]) return { view: 'users' };
      // #/users/{id}/contribution/{cid} - deeper in the same stack, so Back from a
      // contribution lands on the person whose page it was reached from.
      if (segments[2] === 'contribution') {
        return segments[3]
          ? { view: 'contribution', userId: segments[1], contributionId: segments[3] }
          : { view: 'user', userId: segments[1] };
      }
      return { view: 'user', userId: segments[1] };
    case 'word': {
      if (!segments[1]) return DEFAULT_ROUTE;
      const axis = segments[2];
      return { view: 'word', wordId: segments[1], axis: axis && isAxis(axis) ? axis : 'entry' };
    }
    default:
      return DEFAULT_ROUTE;
  }
}

/** The inverse of parseHash. Always returns a leading '#/' form so it can be
 * assigned straight to location.hash or used as an href. */
export function formatRoute(route: Route): string {
  switch (route.view) {
    case 'queue':
      return '#/queue';
    case 'add':
      return '#/add';
    case 'dictionary':
      return `#/dictionary/${route.tab}`;
    case 'dossier':
      return `#/dossier/${encodeURIComponent(route.wordId)}`;
    case 'users':
      return '#/users';
    case 'user':
      return `#/users/${encodeURIComponent(route.userId)}`;
    case 'contribution':
      return `#/users/${encodeURIComponent(route.userId)}/contribution/${encodeURIComponent(route.contributionId)}`;
    case 'word':
      return `#/word/${encodeURIComponent(route.wordId)}/${route.axis}`;
  }
}

/** True when two routes are the same screen, used to avoid pushing a
 * duplicate history entry (which would make Back appear to do nothing). */
export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
