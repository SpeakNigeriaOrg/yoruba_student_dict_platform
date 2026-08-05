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

export type Axis = 'entry' | 'etymology' | 'audio';

export const AXES: readonly Axis[] = ['entry', 'etymology', 'audio'];

export type Route =
  | { view: 'queue' }
  | { view: 'browse' }
  | { view: 'add' }
  | { view: 'contributions' }
  | { view: 'users' }
  | { view: 'user'; userId: string }
  | { view: 'word'; wordId: string; axis: Axis };

export const DEFAULT_ROUTE: Route = { view: 'queue' };

function isAxis(value: string): value is Axis {
  return (AXES as readonly string[]).includes(value);
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
    case 'browse':
      return { view: 'browse' };
    case 'add':
      return { view: 'add' };
    case 'contributions':
      return { view: 'contributions' };
    case 'users':
      // #/users and #/users/{id} are the same stack, which is what collapses
      // AdminUsers' former private selectedUserId state.
      return segments[1] ? { view: 'user', userId: segments[1] } : { view: 'users' };
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
    case 'browse':
      return '#/browse';
    case 'add':
      return '#/add';
    case 'contributions':
      return '#/contributions';
    case 'users':
      return '#/users';
    case 'user':
      return `#/users/${encodeURIComponent(route.userId)}`;
    case 'word':
      return `#/word/${encodeURIComponent(route.wordId)}/${route.axis}`;
  }
}

/** True when two routes are the same screen, used to avoid pushing a
 * duplicate history entry (which would make Back appear to do nothing). */
export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
