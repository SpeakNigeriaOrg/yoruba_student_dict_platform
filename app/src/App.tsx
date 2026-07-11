// App.tsx
//
// Minimal real shell: identity check -> login link or assignments list ->
// etymology review for the selected word. No router library - a handful
// of screens toggled by local state is enough for this pass (see the
// approved plan). Audio recorder, contribution queue, and bulk curator
// assignment view are all explicitly out of scope here, unchanged from
// this package's own README "not yet built" list.

import { useEffect, useState } from 'react';
import { AssignmentsList } from './screens/AssignmentsList.js';
import { EtymologyReview } from './screens/EtymologyReview.js';
import { getClientPrincipal, type ClientPrincipal } from './identity.js';

export default function App() {
  const [principal, setPrincipal] = useState<ClientPrincipal | null | undefined>(undefined);
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);

  useEffect(() => {
    getClientPrincipal().then(setPrincipal);
  }, []);

  return (
    <main>
      <h1>Yoruba Student Dictionary - Curation Platform</h1>

      {principal === undefined ? (
        <p>Checking login status...</p>
      ) : principal === null ? (
        <p>
          <a href="/login">Log in</a> to see your assigned words.
        </p>
      ) : (
        <>
          <p>
            Logged in as {principal.userDetails} <a href="/logout">Log out</a>
          </p>
          {selectedWordId ? (
            <>
              <button type="button" onClick={() => setSelectedWordId(null)}>
                ← Back to assignments
              </button>
              <EtymologyReview wordId={selectedWordId} />
            </>
          ) : (
            <AssignmentsList onSelect={setSelectedWordId} />
          )}
        </>
      )}
    </main>
  );
}
