// types.ts
//
// Shape of the canonical artifact published by the kaikki-yoruba repo
// (entries.json - one normalized entry per raw Kaikki record, keyed by
// entry id), plus this project's own derived-sense shape (what actually
// gets written into db/migrations/0002_kaikki_lexicon.sql's tables).

export interface CanonicalFormInfo {
  value: string;
  inferenceMethod: 'explicit_canonical_tag' | 'fallback_headword';
  confidence: number;
  originalValue: string;
}

export interface AltForm {
  form: string;
  tags: string[];
}

export interface EtymologyTemplate {
  name: string | null;
  args: Record<string, string>;
}

export interface SenseAltOf {
  word: string | null;
  extra: string | null;
}

export interface CanonicalSense {
  id: string | null;
  glosses: string[];
  rawGlosses: string[];
  tags: string[];
  examples: Array<{ text: string | null; translation: string | null }>;
  links: string[];
  altOf: SenseAltOf[];
}

export interface RelationItem {
  type: 'term' | 'external_link';
  text?: string;
  english?: string | null;
  url?: string;
  message?: string;
}

export interface CanonicalEntry {
  id: string;
  headword: string;
  lang: string | null;
  langCode: string | null;
  pos: string | null;
  etymologyNumber: string | null;
  etymologyText: string | null;
  etymologyTemplates: EtymologyTemplate[];
  canonicalForm: CanonicalFormInfo;
  altForms: AltForm[];
  ipa: Array<{ ipa: string; tags: string[]; note: string | null }>;
  senses: CanonicalSense[];
  derivedTerms: RelationItem[];
  relatedTerms: RelationItem[];
  synonyms: RelationItem[];
  antonyms: RelationItem[];
  descendants: RelationItem[];
  forms: { exact: string; toneInsensitive: string; orthographyInsensitive: string };
  provenance: { source: string; sourceLineIndex: number };
}

export type CanonicalEntries = Record<string, CanonicalEntry>;

export interface ComponentCandidate {
  form: string;
  provenance: 'etymology_template' | 'derived_reciprocal';
}

/** This project's own derivation over one canonical entry - mirrors
 * generate_kaikki_lexicon.py's per-record `sense` dict, minus `headword`/
 * `pos`/etc. duplication concerns since those come straight from the
 * canonical entry. `derivedFormTexts` is only ever an input to
 * componentCandidate reciprocal synthesis (deriveSenses.ts) - never
 * persisted, same as the Python original never persists `derivedForms`. */
export interface DerivedKaikkiSense {
  entryId: string;
  pos: string | null;
  etymologyNumber: string | null;
  headword: string;
  canonicalForm: CanonicalFormInfo;
  standardForms: string[];
  glosses: string[];
  altOfTargets: string[];
  componentCandidates: ComponentCandidate[];
  indexKeys: string[];
  derivedFormTexts: string[];
}
