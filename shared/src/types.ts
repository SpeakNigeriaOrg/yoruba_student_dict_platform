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
  headword: string;
  canonicalForm: CanonicalFormInfo;
  standardForms: string[] | null;
  glosses: string[];
  altOfTargets: string[] | null;
  componentCandidates: ComponentCandidate[] | null;
  derivedForms: unknown[];
}

export type KaikkiLexicon = Record<string, KaikkiSense[]>;

export interface DiagnoseOverride {
  note?: string;
  action?: 'keep_ours' | 'adopt_kaikki' | 'select_candidate';
  candidateForm?: string;
  definitionAction?: string;
  syllableAction?: string;
  componentsAction?: string;
}

export type DiagnosticsOverrides = Record<string, DiagnoseOverride>;
