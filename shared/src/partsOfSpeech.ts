// partsOfSpeech.ts
//
// The part-of-speech vocabulary, which is NOT ours to invent.
//
// This field exists for one purpose: an entry with no Wiktionary record has its pos and its
// English gloss recorded nowhere else, so they are collected at creation for the day that entry
// is contributed upstream (see 0018, and the publication fields on createWord/createPhrase).
// That makes the set of legal values a closed one - upstream's own tags, the same strings
// KaikkiSense.pos carries and the same ones an entry we cite already stores in its pin.
//
// It was a free-text box on both the Word and the Phrase tab, with `e.g. noun, verb, intj` for a
// placeholder. Free text cannot record this field correctly: `interjection` is the word a person
// reaches for and `intj` is the only value upstream accepts, and nothing downstream would ever
// notice the difference - the string is stored verbatim and read back verbatim, so the mistake
// only surfaces at the moment of publication, long after whoever made it could say what they
// meant. A closed list is also simply easier to answer than a blank box.
//
// The list is every pos present in the corpus, ordered by how often it occurs there rather than
// alphabetically - the top four cover 94% of entries, so the common answer is the short scroll.
// `character` (a letter of the alphabet) and `name` (a proper noun) are upstream's names for
// categories a contributor would otherwise have to guess at, which is exactly why the label
// beside each tag says what it means.

export interface PartOfSpeech {
  /** Upstream's tag - what is stored, and what would be submitted. */
  value: string;
  /** How it reads to a contributor. Never stored: an entry holds the tag. */
  label: string;
}

export const PARTS_OF_SPEECH: PartOfSpeech[] = [
  { value: 'noun', label: 'noun' },
  { value: 'verb', label: 'verb' },
  { value: 'name', label: 'name (a proper noun - person, place, month)' },
  { value: 'adj', label: 'adjective' },
  { value: 'adv', label: 'adverb' },
  { value: 'pron', label: 'pronoun' },
  { value: 'intj', label: 'interjection (a greeting, an exclamation)' },
  { value: 'num', label: 'numeral' },
  { value: 'det', label: 'determiner' },
  { value: 'prep', label: 'preposition' },
  { value: 'conj', label: 'conjunction' },
  { value: 'particle', label: 'particle' },
  { value: 'phrase', label: 'phrase' },
  { value: 'prep_phrase', label: 'prepositional phrase' },
  { value: 'proverb', label: 'proverb' },
  { value: 'contraction', label: 'contraction' },
  { value: 'character', label: 'character (a letter of the alphabet)' },
  { value: 'prefix', label: 'prefix' },
  { value: 'interfix', label: 'interfix' },
  { value: 'suffix', label: 'suffix' },
];

/** Whether a stored value is one upstream would accept.
 *
 * Deliberately not enforced on the way in by the API: rows created before this list existed hold
 * whatever was typed, and rejecting them on a later edit would make an old entry uneditable for a
 * reason that has nothing to do with the edit. The UI uses this to keep an unrecognised legacy
 * value visible in its dropdown rather than silently swapping it for something else. */
export function isKnownPartOfSpeech(value: string): boolean {
  return PARTS_OF_SPEECH.some((p) => p.value === value);
}
