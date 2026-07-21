// App.tsx
//
// Mobile-native shell: identity check -> login link or assignments list ->
// axis-tabbed review (Spelling / Definition / Etymology / Audio) for the
// selected word. Bottom tab bar for primary navigation, a segmented
// control for the axis switcher - both are pure CSS/layout choices over
// the same state machine this shell already had; no router library, a
// handful of screens toggled by local state is still enough here.

import { useEffect, useState } from 'react';
import { AddWord } from './screens/AddWord.js';
import { AdminUsers } from './screens/AdminUsers.js';
import { AllWordsList } from './screens/AllWordsList.js';
import { AssignmentsList } from './screens/AssignmentsList.js';
import { AudioRecording } from './screens/AudioRecording.js';
import { ContributionQueue } from './screens/ContributionQueue.js';
import { DefinitionReview } from './screens/DefinitionReview.js';
import { EtymologyReview } from './screens/EtymologyReview.js';
import { SpellingReview } from './screens/SpellingReview.js';
import { getAxisStatus, type AxisDecided } from './api.js';
import { getClientPrincipal, type ClientPrincipal } from './identity.js';

type Axis = 'spelling' | 'definition' | 'etymology' | 'audio';
const AXES: Array<{ key: Axis; label: string }> = [
  { key: 'spelling', label: 'Spelling' },
  { key: 'definition', label: 'Definition' },
  { key: 'etymology', label: 'Etymology' },
  { key: 'audio', label: 'Audio' },
];

type MainView = 'assignments' | 'allWords' | 'addWord' | 'contributions' | 'adminUsers';
const MAIN_VIEWS: Array<{ key: MainView; label: string; icon: string }> = [
  { key: 'assignments', label: 'Assignments', icon: '📋' },
  { key: 'allWords', label: 'Browse', icon: '🔍' },
  { key: 'addWord', label: 'Add', icon: '➕' },
  { key: 'contributions', label: 'Review', icon: '✅' },
  { key: 'adminUsers', label: 'Users', icon: '👥' },
];

export default function App() {
  const [principal, setPrincipal] = useState<ClientPrincipal | null | undefined>(undefined);
  const [mainView, setMainView] = useState<MainView>('assignments');
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [selectedAxis, setSelectedAxis] = useState<Axis>('spelling');
  const [axisStatus, setAxisStatus] = useState<AxisDecided | null>(null);

  useEffect(() => {
    getClientPrincipal().then(setPrincipal);
  }, []);

  // Re-fetched on every axis switch (not just word selection) so the tab
  // colors pick up a decision just made on another axis as soon as the
  // curator switches away from it - cheap, and avoids threading a
  // "decision changed" callback through every review screen.
  useEffect(() => {
    if (!selectedWordId) {
      setAxisStatus(null);
      return;
    }
    let cancelled = false;
    getAxisStatus(selectedWordId)
      .then((result) => {
        if (!cancelled) setAxisStatus(result);
      })
      .catch(() => {
        if (!cancelled) setAxisStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWordId, selectedAxis]);

  function selectWord(wordId: string) {
    setSelectedWordId(wordId);
    setSelectedAxis('spelling');
  }

  const isCurator = principal?.userRoles.includes('curator') ?? false;

  return (
    <main>
      <div className="topbar">
        <h1>Yoruba Student Dictionary</h1>
        {principal ? (
          <p className="identity-line">
            {principal.userDetails} <a href="/logout">Log out</a>
          </p>
        ) : null}
      </div>

      {principal === undefined ? (
        <p>Checking login status...</p>
      ) : principal === null ? (
        <p>
          <a href="/login">Log in</a> to see your assigned words.
        </p>
      ) : (
        <>
          {selectedWordId ? (
            <>
              <button type="button" className="back-btn" onClick={() => setSelectedWordId(null)}>
                ← Back
              </button>
              <nav aria-label="Review axis tabs" className="axis-tabs">
                {AXES.map((axis) => (
                  <button
                    key={axis.key}
                    type="button"
                    aria-current={selectedAxis === axis.key ? 'page' : undefined}
                    className={axisStatus ? (axisStatus[axis.key] ? 'axis-complete' : 'axis-pending') : undefined}
                    onClick={() => setSelectedAxis(axis.key)}
                  >
                    {axis.label}
                  </button>
                ))}
              </nav>
              {selectedAxis === 'spelling' ? <SpellingReview wordId={selectedWordId} isCurator={isCurator} /> : null}
              {selectedAxis === 'definition' ? <DefinitionReview wordId={selectedWordId} isCurator={isCurator} /> : null}
              {selectedAxis === 'etymology' ? <EtymologyReview wordId={selectedWordId} isCurator={isCurator} /> : null}
              {selectedAxis === 'audio' ? <AudioRecording wordId={selectedWordId} /> : null}
            </>
          ) : (
            <>
              {mainView === 'allWords' && isCurator ? (
                <AllWordsList onSelect={selectWord} />
              ) : mainView === 'addWord' && isCurator ? (
                <AddWord />
              ) : mainView === 'contributions' && isCurator ? (
                <ContributionQueue />
              ) : mainView === 'adminUsers' && isCurator ? (
                <AdminUsers onSelectWord={selectWord} />
              ) : (
                <AssignmentsList onSelect={selectWord} />
              )}
            </>
          )}

          {!selectedWordId && isCurator ? (
            <nav aria-label="Main navigation" className="bottom-nav">
              {MAIN_VIEWS.map((view) => (
                <button
                  key={view.key}
                  type="button"
                  aria-current={mainView === view.key ? 'page' : undefined}
                  onClick={() => setMainView(view.key)}
                >
                  <span className="nav-icon" aria-hidden="true">
                    {view.icon}
                  </span>
                  {view.label}
                </button>
              ))}
            </nav>
          ) : null}
        </>
      )}
    </main>
  );
}
