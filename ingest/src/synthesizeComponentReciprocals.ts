// synthesizeComponentReciprocals.ts
//
// Ports generate_kaikki_lexicon.py's synthesize_component_relationships
// (itself a port of yorubadict's build/lib/relationships.mjs approach): a
// compound's own etymology templates only ever give the forward direction
// (compound -> its parts). The reverse - a root's derived-terms list
// naming a compound with no clean etymology template of its own, or none
// at all - is exactly the asymmetric Wiktionary-editor gap this exists to
// fix. Mutates each sense's componentCandidates in place (tagging
// reciprocal entries with their own provenance), so a human reviewing a
// proposal later can tell "Kaikki's own etymology for this word says so"
// apart from "inferred because some other word's derived-terms list names
// this one".

import type { DerivedKaikkiSense } from './types.js';

export function synthesizeComponentReciprocals(senses: DerivedKaikkiSense[]): void {
  // spelling -> every sense findable under that exact spelling (its
  // canonical form or any of its standard forms) - independent of the
  // orthography-insensitive index keys used for lookup elsewhere.
  const aliasIndex = new Map<string, DerivedKaikkiSense[]>();
  const addAlias = (key: string, sense: DerivedKaikkiSense): void => {
    const existing = aliasIndex.get(key);
    if (existing) existing.push(sense);
    else aliasIndex.set(key, [sense]);
  };

  for (const sense of senses) {
    addAlias(sense.canonicalForm.value, sense);
    for (const form of sense.standardForms) {
      addAlias(form, sense);
    }
  }

  for (const sense of senses) {
    for (const derivedSpelling of sense.derivedFormTexts) {
      const targets = aliasIndex.get(derivedSpelling) ?? [];
      for (const target of targets) {
        const alreadyPresent = target.componentCandidates.some((c) => c.form === sense.canonicalForm.value);
        if (!alreadyPresent) {
          target.componentCandidates.push({ form: sense.canonicalForm.value, provenance: 'derived_reciprocal' });
        }
      }
    }
  }
}
