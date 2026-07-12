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
import { AddWord } from './screens/AddWord.js';
import { AllWordsList } from './screens/AllWordsList.js';
import { AssignmentsList } from './screens/AssignmentsList.js';
import { ContributionQueue } from './screens/ContributionQueue.js';
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

type MainView = 'assignments' | 'allWords' | 'addWord' | 'contributions';

export default function App() {
  const [principal, setPrincipal] = useState<ClientPrincipal | null | undefined>(undefined);
  const [mainView, setMainView] = useState<MainView>('assignments');
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [selectedAxis, setSelectedAxis] = useState<Axis>('spelling');

  useEffect(() => {
    getClientPrincipal().then(setPrincipal);
  }, []);

  function selectWord(wordId: string) {
    setSelectedWordId(wordId);
    setSelectedAxis('spelling');
  }

  const isCurator = principal?.userRoles.includes('curator') ?? false;

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
                ← Back
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
              {selectedAxis === 'spelling' ? <SpellingReview wordId={selectedWordId} isCurator={isCurator} /> : null}
              {selectedAxis === 'definition' ? <DefinitionReview wordId={selectedWordId} isCurator={isCurator} /> : null}
              {selectedAxis === 'etymology' ? <EtymologyReview wordId={selectedWordId} isCurator={isCurator} /> : null}
            </>
          ) : (
            <>
              {isCurator ? (
                <nav aria-label="Main navigation">
                  <button
                    type="button"
                    aria-current={mainView === 'assignments' ? 'page' : undefined}
                    onClick={() => setMainView('assignments')}
                  >
                    My assignments
                  </button>
                  <button
                    type="button"
                    aria-current={mainView === 'allWords' ? 'page' : undefined}
                    onClick={() => setMainView('allWords')}
                  >
                    Browse all words
                  </button>
                  <button
                    type="button"
                    aria-current={mainView === 'addWord' ? 'page' : undefined}
                    onClick={() => setMainView('addWord')}
                  >
                    Add a word
                  </button>
                  <button
                    type="button"
                    aria-current={mainView === 'contributions' ? 'page' : undefined}
                    onClick={() => setMainView('contributions')}
                  >
                    Review contributions
                  </button>
                </nav>
              ) : null}
              {mainView === 'allWords' && isCurator ? (
                <AllWordsList onSelect={selectWord} />
              ) : mainView === 'addWord' && isCurator ? (
                <AddWord />
              ) : mainView === 'contributions' && isCurator ? (
                <ContributionQueue />
              ) : (
                <AssignmentsList onSelect={selectWord} />
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
