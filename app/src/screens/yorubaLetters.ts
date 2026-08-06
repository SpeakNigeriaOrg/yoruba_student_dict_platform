// screens/yorubaLetters.ts
//
// The characters a Yoruba writer needs that a phone keyboard will not give them.
//
// That list is exactly six, and it is short for a specific reason: tone is entered on the
// tone grid, which GENERATES the marks, so no combining diacritic is ever typed. What is
// left is the three underdotted letters - and their capitals, which are distinct
// codepoints, not a shift state the device can synthesise:
//
//   ẹ U+1EB9   ọ U+1ECD   ṣ U+1E63
//   Ẹ U+1EB8   Ọ U+1ECC   Ṣ U+1E62
//
// The capitals are not a nicety. A sentence example like `Ọ̀pọ̀lọ́ ń fò` ("the frog hops")
// begins with one, and no amount of long-pressing `O` on an iOS or Android keyboard
// produces `Ọ`.
//
// The underdot is a LETTER, not an accent: ẹ ọ ṣ are distinct phonemes from e o s, which
// is why they belong in a letters palette and tone belongs in the grid. Keeping the two
// apart is the whole reason a contributor cannot produce a malformed spelling.

/** Lowercase only - for the entry axis's per-syllable letters boxes, where a word's
 * capitalisation is already settled and only the letters within a syllable are edited. */
export const EXTRA_LETTERS_LOWER = ['ẹ', 'ọ', 'ṣ'] as const;

/** All six - for authoring a phrase from scratch, which may begin with a capital. */
export const EXTRA_LETTERS = ['ẹ', 'ọ', 'ṣ', 'Ẹ', 'Ọ', 'Ṣ'] as const;
