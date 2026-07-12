// types.ts
//
// Shapes of the real data this package consumes - vocab.json, Kaikki's
// exported lexicon, and dictionary_overrides.json, as produced by
// yoruba-student-dict's scripts/*.py. Kept as plain data interfaces (no
// class/validation layer) since these are just JSON documents this package
// reads, never constructs itself.

export interface VocabEntry {
  displayText: string;
  syllables: string[];
  definition?: string;
  components?: string[];
  type?: 'phrase';
}

export type Vocab = Record<string, VocabEntry>;

export interface CanonicalFormInfo {
  value: string;
  inferenceMethod: string;
  confidence: number;
  originalValue: string;
}

export interface ComponentCandidate {
  form: string;
  provenance: string;
}

export interface KaikkiSense {
  pos: string;
  etymologyNumber: string | null;
  /** Kaikki/Wiktionary's free-text etymology prose - distinct from
   * componentCandidates (the structured decomposition). A real, sizeable
   * fraction of entries have only this, no structured template at all -
   * worth surfacing to a curator even when nothing could be mechanically
   * decomposed from it. Optional/nullable for the same reason
   * usedInCandidates is - older fixtures/callers that only need the rest
   * of the shape don't need to supply it. */
  etymologyText?: string | null;
  headword: string;
  canonicalForm: CanonicalFormInfo;
  standardForms: string[] | null;
  glosses: string[];
  altOfTargets: string[] | null;
  componentCandidates: ComponentCandidate[] | null;
  /** The reverse of componentCandidates - other words' spellings that
   * kaikki-yoruba's own etymology-driven resolution says use this sense as
   * a component (see kaikki-yoruba's usedInCompounds). Optional/nullable
   * since callers that only need the forward direction (e.g. tests using
   * older fixtures) don't need to supply it. */
  usedInCandidates?: ComponentCandidate[] | null;
  derivedForms: unknown[];
}

export type KaikkiLexicon = Record<string, KaikkiSense[]>;

export interface DiagnoseOverride {
  note?: string;
  action?: 'keep_ours' | 'adopt_kaikki' | 'select_candidate';
  candidateForm?: string;
  definitionAction?: 'confirm' | 'custom';
  definitionText?: string;
  definitionSourceForm?: string;
  syllableAction?: 'keep_manual' | 'accept_programmatic';
  syllableNote?: string;
  componentsAction?: string;
  components?: string[];
}

export type DiagnosticsOverrides = Record<string, DiagnoseOverride>;
