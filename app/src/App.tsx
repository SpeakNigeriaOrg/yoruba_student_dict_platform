// App.tsx
//
// Minimal real shell: identity check -> login link or assignments list ->
// axis-tabbed review (Spelling / Definition / Etymology) for the selected
// word. No router library - a handful of screens toggled by local state is
// enough for this pass (see the approved plan). Audio recorder,
// contribution queue, and bulk curator assignment view are all explicitly
// out of scope here, unchanged from this package's own README "not yet
// built" list.

import { useEffect, useState } from 'react';
import { AssignmentsList } from './screens/AssignmentsList.js';
import { DefinitionReview } from './screens/DefinitionReview.js';
import { EtymologyReview } from './screens/EtymologyReview.js';
import { SpellingReview } from './screens/SpellingReview.js';
import { getClientPrincipal, type ClientPrincipal } from './identity.js';

type Axis = 'spelling' | 'definition' | 'etymology';
const AXES: Array<{ key: Axis; label: string }> = [
  { key: 'spelling', label: 'Spelling' },
  { key: 'definition', label: 'Definition' },
  { key: 'etymology', label: 'Etymology' },
];

export default function App() {
  const [principal, setPrincipal] = useState<ClientPrincipal | null | undefined>(undefined);
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [selectedAxis, setSelectedAxis] = useState<Axis>('spelling');

  useEffect(() => {
    getClientPrincipal().then(setPrincipal);
  }, []);

  function selectWord(wordId: string) {
    setSelectedWordId(wordId);
    setSelectedAxis('spelling');
  }

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
              <nav aria-label="Review axis tabs">
                {AXES.map((axis) => (
                  <button
                    key={axis.key}
                    type="button"
                    aria-current={selectedAxis === axis.key ? 'page' : undefined}
                    onClick={() => setSelectedAxis(axis.key)}
                  >
                    {axis.label}
                  </button>
                ))}
              </nav>
              {selectedAxis === 'spelling' ? <SpellingReview wordId={selectedWordId} /> : null}
              {selectedAxis === 'definition' ? <DefinitionReview wordId={selectedWordId} /> : null}
              {selectedAxis === 'etymology' ? <EtymologyReview wordId={selectedWordId} /> : null}
            </>
          ) : (
            <AssignmentsList onSelect={selectWord} />
          )}
        </>
      )}
    </main>
  );
}
