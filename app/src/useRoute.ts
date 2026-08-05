// useRoute.ts
//
// The DOM half of route.ts: reads location.hash, re-renders on hashchange,
// and navigates by assigning location.hash (which pushes a history entry, so
// the OS back gesture walks back through the app instead of leaving it).
//
// `replace` is for transitions that should not be separately undoable - most
// importantly advancing the task queue, where a Back press should return to
// the previous SCREEN, not replay the task the user just finished.

import { useCallback, useEffect, useState } from 'react';
import { formatRoute, parseHash, sameRoute, type Route } from './route.js';

export interface UseRouteResult {
  route: Route;
  navigate: (next: Route, options?: { replace?: boolean }) => void;
}

export function useRoute(): UseRouteResult {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    // The initial hash may have been empty (a bare '/' visit). Normalising it
    // here means every subsequent navigation has a real entry to go back to,
    // and a refresh lands on the same screen.
    if (!window.location.hash) {
      window.history.replaceState(null, '', formatRoute(route));
    }
    return () => window.removeEventListener('hashchange', onHashChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback(
    (next: Route, options?: { replace?: boolean }) => {
      const href = formatRoute(next);
      if (sameRoute(next, parseHash(window.location.hash))) return;
      if (options?.replace) {
        window.history.replaceState(null, '', href);
        setRoute(next);
      } else {
        // Assigning hash (rather than pushState) is what fires hashchange,
        // keeping this hook's state and the URL in sync through one path.
        window.location.hash = href;
      }
    },
    [],
  );

  return { route, navigate };
}
