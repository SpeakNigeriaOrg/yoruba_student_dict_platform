// deriveSenses.ts
//
// Ports yoruba-student-dict/scripts/generate_kaikki_lexicon.py's own
// derivation rules (pick_canonical_form/extract_glosses/
// extract_alt_of_targets/extract_component_candidates/
// extract_derived_forms/build_lexicon's standardForms+indexing logic),
// retargeted to read from kaikki-yoruba's canonical artifact shape
// instead of raw Kaikki JSONL records - same rules, new input. See that
// Python file's own comments for the full rationale behind each rule;
// this file mirrors its structure closely enough to diff against.

import { orthographyInsensitiveForm } from '@yoruba-student-dict-platform/shared';
import type { AltForm, CanonicalEntry, ComponentCandidate, DerivedKaikkiSense } from './types.js';

// Forms tagged only with these are still standard modern Yoruba spelling
// variants worth treating as equivalent to canonical (case notes, script
// notes). Anything tagged otherwise - a dialect region name like "Ekiti",
// "archaic", "romanization" - is a real, deliberate variant that shouldn't
// silently count as a match for our modern-standard vocab spelling. An
// untagged form has no signal either way, so it's treated as standard by
// default.
const STANDARD_FORM_TAGS = new Set(['canonical', 'alternative', 'lowercase', 'uppercase', 'Latin']);

// Dialect/temporal markers live on a record's SENSES, not on its forms'
// tags. A record like this shouldn't bridge its alternate forms into some
// OTHER word's candidate pool as if they were equivalent modern-standard
// spellings.
const NONSTANDARD_SENSE_TAGS = new Set(['Ekiti', 'archaic', 'historical', 'obsolete', 'dated', 'rare']);

// Only templates that decompose a word into other real, same-language
// Yoruba words. Excludes affix/af/prefix (bound morphemes - their args are
// literally hyphenated, e.g. "a-", not independent words) and
// cross-language cognate/borrowing templates like cog/bor/inh/der/
// doublet/calque (their numeric arg is a language code, not a Yoruba
// spelling).
const COMPONENT_TEMPLATE_NAMES = new Set(['compound', 'com', 'compound+', 'reduplication', 'blend']);

function isStandardForm(form: AltForm): boolean {
  return form.tags.every((t) => STANDARD_FORM_TAGS.has(t));
}

export function hasNonstandardSense(entry: CanonicalEntry): boolean {
  return entry.senses.some((sense) => sense.tags.some((t) => NONSTANDARD_SENSE_TAGS.has(t)));
}

export function deriveStandardForms(entry: CanonicalEntry): string[] {
  const values = new Set<string>([entry.canonicalForm.value]);
  for (const f of entry.altForms) {
    if (f.form && isStandardForm(f)) values.add(f.form);
  }
  return [...values].sort();
}

export function deriveGlosses(entry: CanonicalEntry): string[] {
  const glosses: string[] = [];
  for (const sense of entry.senses) {
    glosses.push(...sense.glosses);
  }
  return glosses;
}

/** Distinct target words from any alt_of-tagged sense on this entry -
 * Kaikki's own structured cross-reference data, not prose to parse. Used
 * downstream to let a word's definition automatically follow a
 * content-free cross-reference to its real entry (see
 * generate_diagnostics.py's resolve_definition_source). */
export function deriveAltOfTargets(entry: CanonicalEntry): string[] {
  const targets: string[] = [];
  for (const sense of entry.senses) {
    for (const alt of sense.altOf) {
      if (alt.word && !targets.includes(alt.word)) targets.push(alt.word);
    }
  }
  return targets;
}

/** Component word spellings from this entry's own etymologyTemplates -
 * the forward direction only (this word -> the words it's built from).
 * See COMPONENT_TEMPLATE_NAMES for which templates are trusted. Returns
 * plain spellings, not yet {form, provenance} - that wrapping (and the
 * reciprocal "derived_reciprocal" entries) happens in
 * synthesizeComponentReciprocals, mirroring generate_kaikki_lexicon.py's
 * own two-phase shape exactly (componentCandidates starts as list[str] in
 * build_lexicon, only becomes list[dict] inside
 * synthesize_component_relationships). */
export function deriveComponentCandidateForms(entry: CanonicalEntry): string[] {
  const candidates: string[] = [];
  for (const t of entry.etymologyTemplates) {
    if (!t.name || !COMPONENT_TEMPLATE_NAMES.has(t.name)) continue;
    const args = t.args ?? {};
    if (args['1'] !== 'yo') continue;
    const numericKeys = Object.keys(args)
      .filter((k) => /^\d+$/.test(k) && k !== '1')
      .sort((a, b) => Number(a) - Number(b));
    const forms = numericKeys.map((k) => args[k]).filter((f): f is string => Boolean(f));
    if (forms.some((f) => f.startsWith('-') || f.endsWith('-'))) continue;
    for (const f of forms) {
      if (!candidates.includes(f)) candidates.push(f);
    }
  }
  return candidates;
}

/** Raw spellings this entry's own `derivedTerms` names (Kaikki's
 * editor-curated "derived terms" list) - only ever the reverse direction
 * (this word -> compounds built from it), resolved into reciprocal
 * componentCandidates entries by synthesizeComponentReciprocals, never
 * used directly. `external_link` items (yorubadict's normalizer already
 * collapsed garbled dialect-table data into these) are skipped - they're
 * not a real spelling. */
export function deriveDerivedFormTexts(entry: CanonicalEntry): string[] {
  const forms: string[] = [];
  for (const item of entry.derivedTerms) {
    if (item.type === 'term' && item.text && !forms.includes(item.text)) {
      forms.push(item.text);
    }
  }
  return forms;
}

/** Every spelling this entry is findable under: the headword, its
 * canonical form, and (for entries that are themselves standard, modern-
 * Yoruba entries) every alternate form regardless of that form's own tag.
 * A record whose senses are dialectal/archaic doesn't get this expansion -
 * it's still findable under its own headword/canonical, it just doesn't
 * get to bridge into some OTHER word's candidate pool via its
 * cross-referenced forms. */
export function deriveIndexKeys(entry: CanonicalEntry): string[] {
  const keys = new Set<string>([
    orthographyInsensitiveForm(entry.headword),
    orthographyInsensitiveForm(entry.canonicalForm.value),
  ]);
  if (!hasNonstandardSense(entry)) {
    for (const f of entry.altForms) {
      if (f.form) keys.add(orthographyInsensitiveForm(f.form));
    }
  }
  return [...keys];
}

export function deriveSense(entry: CanonicalEntry): DerivedKaikkiSense {
  return {
    entryId: entry.id,
    pos: entry.pos,
    etymologyNumber: entry.etymologyNumber,
    headword: entry.headword,
    canonicalForm: entry.canonicalForm,
    standardForms: deriveStandardForms(entry),
    glosses: deriveGlosses(entry),
    altOfTargets: deriveAltOfTargets(entry),
    componentCandidates: deriveComponentCandidateForms(entry).map(
      (form): ComponentCandidate => ({ form, provenance: 'etymology_template' }),
    ),
    indexKeys: deriveIndexKeys(entry),
    derivedFormTexts: deriveDerivedFormTexts(entry),
  };
}

export function deriveSenses(entries: CanonicalEntry[]): DerivedKaikkiSense[] {
  return entries.map(deriveSense);
}
