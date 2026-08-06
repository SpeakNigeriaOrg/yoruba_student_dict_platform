// screens/PhraseComposer.tsx
//
// Writing a Yoruba phrase correctly, without assuming the contributor's phone can produce
// a single Yoruba character.
//
// ---------------------------------------------------------------------------
// This is the "on-screen keyboard", and it is six keys
// ---------------------------------------------------------------------------
// Not a full keypad. Tone is entered on the grid, which GENERATES the marks, so no
// combining diacritic is ever typed. That leaves exactly the six characters no phone
// keyboard offers - ẹ ọ ṣ and their capitals - as tap-to-insert keys, and everything else
// comes from the device keyboard where a-z already works.
//
// It also degrades upward rather than getting in the way: a contributor who does have
// Keyman and types `Ọ̀pọ̀lọ́ ń fò` in full gets the grids pre-filled from what they wrote,
// so the tone step becomes a confirmation instead of re-entry.
//
// ---------------------------------------------------------------------------
// One source of truth
// ---------------------------------------------------------------------------
// The text field holds the composed phrase - marks included - and nothing else is stored.
// Tone edits rewrite that string; the words and their syllables are re-derived from it on
// every render. The alternative (raw text plus a separate set of tone overrides) has two
// states that can disagree, and the thing they would disagree about is exactly what gets
// saved. Here what the contributor reads in the field IS what is submitted.
//
// That works because splitPhrase and joinPhrase round-trip: see phraseWords.test.ts, which
// asserts it over every example shape in the request.

import { useEffect, useRef, useState } from 'react';
import { joinPhrase, splitPhrase, withWordSyllables } from './phraseWords.js';
import { EXTRA_LETTERS } from './yorubaLetters.js';
import { ToneGrid } from './ToneGrid.js';

export interface PhraseComposerProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  /** Distinguishes this composer's field and per-word controls from another's.
   *
   * Required rather than defaulted: the id was hardcoded when there was one composer in the
   * app, and a second one (the word-request flow) would have produced duplicate DOM ids and
   * an ambiguous getByLabelText - which surfaces as a baffling test failure rather than as
   * the real bug. Making it required means a new caller cannot reintroduce that. */
  id: string;
}

export function PhraseComposer({ value, onChange, label, placeholder, id }: PhraseComposerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Where to put the caret after a programmatic edit. Null when the browser should keep
   * whatever it had - i.e. on ordinary typing. */
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);

  useEffect(() => {
    if (pendingCaret === null) return;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(pendingCaret, pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret]);

  /** Inserts at the caret, not at the end.
   *
   * A phrase gets edited in the middle - noticing a missing underdot in the first word
   * after typing the third is the normal case, and appending would put the letter in the
   * wrong word entirely. Replaces the selection if there is one, like a keypress would. */
  function insertLetter(letter: string) {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + letter + value.slice(end);
    onChange(next);
    setPendingCaret(start + letter.length);
  }

  const { words, separators } = splitPhrase(value);
  const toneable = words.filter((w) => w.syllables !== null);

  return (
    <div aria-label="Phrase composer">
      <div className="field">
        <label htmlFor={`${id}-field`}>{label}</label>
        <input
          id={`${id}-field`}
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="letter-palette phrase-palette" role="group" aria-label="Yoruba letters">
          {EXTRA_LETTERS.map((letter) => (
            <button
              key={letter}
              type="button"
              className="btn btn-secondary palette-btn"
              onClick={() => insertLetter(letter)}
            >
              {letter}
            </button>
          ))}
        </div>
        <p className="field-note">
          Type the letters with your own keyboard. Tap <strong>ẹ ọ ṣ</strong> above for the letters it does not have -
          the underdot is part of the letter, not a tone mark. Set the tones below.
        </p>
      </div>

      {toneable.length === 0 ? null : (
        <div className="field">
          <p className="field-note">
            One grid per word, top to bottom high / mid / low. Tap a cell to set that syllable's tone - you never need
            to type an accent.
          </p>
          {words.map((word, index) =>
            word.syllables === null ? null : (
              <div key={index} className="phrase-word">
                <p className="phrase-word-label">{word.leading + word.syllables.join('') + word.trailing}</p>
                <ToneGrid
                  syllables={word.syllables}
                  labelSuffix={words.length > 1 ? ` of word ${index + 1}` : ''}
                  onChange={(syllables) => onChange(joinPhrase(withWordSyllables(words, index, syllables), separators))}
                />
              </div>
            ),
          )}
        </div>
      )}

      {words.some((w) => w.core !== '' && w.syllables === null) ? (
        <p className="field-note" aria-label="Unsupported words">
          Some of what you typed cannot be split into syllables, so it has no tone grid and is saved exactly as you
          wrote it. Hyphens and unusual spellings do this.
        </p>
      ) : null}
    </div>
  );
}
