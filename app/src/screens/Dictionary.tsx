// screens/Dictionary.tsx
//
// The curating surface: one place, four views of the same corpus.
//
// ---------------------------------------------------------------------------
// Why this replaced two tabs
// ---------------------------------------------------------------------------
// Browse and Review were separate destinations asking two questions about one thing - what
// is in the dictionary, and what needs deciding. Keeping them apart meant a curator could
// not get from "eleven words are contested" to those eleven words, and Browse answered its
// question with per-user flags because nothing had ever asked it to answer the corpus-wide
// one.
//
// ---------------------------------------------------------------------------
// The level is the place
// ---------------------------------------------------------------------------
// Everything here is curating: facts about the corpus, and decisions about the record.
// Contributing - having an opinion about a word, with the same imperfect knowledge as
// anyone else - happens on the word screens, which a curator reaches from here by pressing
// Review. Nothing on this surface is scoped to the person reading it.

import { DictionarySurvey } from './DictionarySurvey.js';
import { CoverageView } from './CoverageView.js';
import { RightsRoster } from './RightsRoster.js';
import { ReviewQueue } from './ReviewQueue.js';
import type { DictionaryView } from '../route.js';
import type { Axis } from '../route.js';

const TABS: Array<{ view: DictionaryView; label: string }> = [
  { view: 'overview', label: 'Overview' },
  { view: 'words', label: 'Words' },
  { view: 'decisions', label: 'Decisions' },
  { view: 'coverage', label: 'Coverage' },
  { view: 'rights', label: 'Rights' },
];

export interface DictionaryProps {
  tab: DictionaryView;
  onTabChange: (tab: DictionaryView) => void;
  onOpenWord: (wordId: string, axis: Axis) => void;
  onOpenDossier: (wordId: string) => void;
}

export function Dictionary({ tab, onTabChange, onOpenWord, onOpenDossier }: DictionaryProps) {
  return (
    <div className="curating">
      <nav className="surface-tabs" aria-label="Dictionary views">
        {TABS.map((t) => (
          <button
            key={t.view}
            type="button"
            aria-current={tab === t.view ? 'page' : undefined}
            onClick={() => onTabChange(t.view)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'rights' ? (
        <RightsRoster />
      ) : tab === 'coverage' ? (
        <CoverageView />
      ) : tab === 'decisions' ? (
        <ReviewQueue onOpenWord={onOpenWord} />
      ) : (
        <DictionarySurvey
          tab={tab}
          onTabChange={onTabChange}
          onOpenDossier={onOpenDossier}
          onOpenWord={(wordId) => onOpenWord(wordId, 'entry')}
        />
      )}
    </div>
  );
}
