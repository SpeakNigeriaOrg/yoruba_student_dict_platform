// handlers/seedAffixEntries.ts
//
// Adds Yoruba's affixes (ì-, à-, oní-, -kí- ...) to the dictionary, so an etymology like ìlà can be
// recorded as [ì-, là] rather than as là alone. One-off; see scripts/seedAffixEntries.mjs.
//
// Two populations, both read from the ingested Wiktionary data (run ingest first - since 0031 it
// keeps affixes as etymology parts, with each part's gloss):
//
//   CITED   - every affix Wiktionary has an entry for (pos prefix / interfix / suffix). Created
//             citing that entry, so its part of speech and gloss come from the pin like any cited
//             word. The student definition starts as Wiktionary's first gloss.
//   EXEMPT  - every affix that appears as an etymology part but has no entry of its own (à-, a-,
//             ò-, ẹ̀-...). Created with an exempt citation, a part of speech inferred from where the
//             hyphen is, and the gloss the etymology templates most often give it - as both the
//             student definition and the English gloss, since there is no pin to fall back on.
//             Forms no template ever glosses are created without one and reported, for a curator.
//
// Every entry is standard in every other respect: reviewed on all four axes, audio included.
// It is "not a standalone word" (0030) by its part of speech, which keeps it out of the game
// export and nothing else.
//
// Skips any form the dictionary already holds under that spelling (oní- and abi- exist), and any
// Wiktionary entry already cited. Created through createWord, so each carries its author's vote.

import type pg from 'pg';
import { deriveWordId, meaningSlug, syllabifyWord } from '@yoruba-student-dict-platform/shared';
import { withTransaction, type Queryable } from '../db.js';
import { createWordInTransaction } from './createWord.js';
import { recordAuthoringVote } from './authoringVote.js';

export const EXEMPT_REASON = 'affix with no Wiktionary entry of its own';

export interface AffixSeedItem {
  kind: 'cited' | 'exempt';
  wordId: string;
  displayText: string;
  pos: 'prefix' | 'interfix' | 'suffix';
  /** The student definition (and, for exempt, the English gloss). Null when nothing glosses it. */
  gloss: string | null;
  /** Cited only. */
  entryId?: string;
  /** How many etymologies in the corpus use this form as a part - for the report. */
  uses: number;
}

export interface AffixSeedSkip {
  displayText: string;
  reason: 'already_in_dictionary' | 'entry_already_cited';
  existingWordId: string;
}

export interface AffixSeedPlan {
  planned: AffixSeedItem[];
  skipped: AffixSeedSkip[];
}

/** The first three words of a gloss's slug - "adds_the_meaning", not the whole sentence. */
function shortHint(gloss: string): string {
  return meaningSlug(gloss).split('_').filter(Boolean).slice(0, 3).join('_');
}

/** What an ASCII word_id loses from a spelling: underdots and tone marks, as words. `ọ̀-` gives
 * "dot_low". Used only to tell apart forms whose ids would otherwise collide - ò-, ọ̀-, ọ- and o-
 * are all glossed "nominalizing prefix". */
function diacriticHint(form: string): string {
  const marks = form.normalize('NFD');
  const words: string[] = [];
  if (marks.includes('\u0323')) words.push('dot');
  if (marks.includes('\u0300')) words.push('low');
  if (marks.includes('\u0301')) words.push('high');
  return words.join('_');
}

function posFromHyphens(form: string): AffixSeedItem['pos'] {
  if (form.startsWith('-') && form.endsWith('-')) return 'interfix';
  if (form.startsWith('-')) return 'suffix';
  return 'prefix';
}

export async function planAffixSeed(client: Queryable): Promise<AffixSeedPlan> {
  const [senses, parts, existing] = await Promise.all([
    client.query<{ entry_id: string; canonical_value: string; pos: 'prefix' | 'interfix' | 'suffix'; glosses: string[] | null }>(
      `select entry_id, canonical_value, pos, glosses from kaikki_senses
        where pos in ('prefix', 'interfix', 'suffix') and entry_id is not null
        order by canonical_value, entry_id`,
    ),
    // Bound etymology parts: a hyphen at either end. Hyphenated FREE parts (numerals like márùn-ún)
    // have it in the middle, so they are not matched.
    client.query<{ form: string; gloss: string | null; n: string }>(
      `select form, gloss, count(*) as n from kaikki_component_candidates
        where provenance = 'etymology_template' and (form like '%-' or form like '-%')
        group by form, gloss`,
    ),
    client.query<{ word_id: string; display_text: string; entry_id: string | null }>(
      `select g.word_id, g.display_text, c.entry_id
         from golden_record g left join upstream_citations c on c.word_id = g.word_id`,
    ),
  ]);

  const nfc = (s: string) => s.normalize('NFC');
  const heldBySpelling = new Map(existing.rows.map((r) => [nfc(r.display_text), r.word_id]));
  const heldByEntry = new Map(existing.rows.filter((r) => r.entry_id).map((r) => [r.entry_id as string, r.word_id]));
  const takenIds = new Set(existing.rows.map((r) => r.word_id));

  // Uses and most common gloss per form, over the etymology parts.
  const usage = new Map<string, { uses: number; glosses: Map<string, number> }>();
  for (const r of parts.rows) {
    const form = nfc(r.form);
    const u = usage.get(form) ?? { uses: 0, glosses: new Map<string, number>() };
    u.uses += Number(r.n);
    if (r.gloss) u.glosses.set(r.gloss, (u.glosses.get(r.gloss) ?? 0) + Number(r.n));
    usage.set(form, u);
  }
  const commonestGloss = (form: string): string | null => {
    const g = usage.get(form)?.glosses;
    if (!g || g.size === 0) return null;
    return [...g.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  };

  /** Placeholder ids; assignIds replaces them once every item is known, so a collision can be
   * resolved by what the colliding forms actually differ in. */
  const mintId = (form: string, hint: string): string => deriveWordId(form, shortHint(hint));

  const plan: AffixSeedPlan = { planned: [], skipped: [] };
  const plannedSpellings = new Set<string>();

  for (const s of senses.rows) {
    const form = nfc(s.canonical_value);
    const citedBy = heldByEntry.get(s.entry_id);
    if (citedBy) {
      plan.skipped.push({ displayText: form, reason: 'entry_already_cited', existingWordId: citedBy });
      continue;
    }
    const held = heldBySpelling.get(form);
    if (held) {
      plan.skipped.push({ displayText: form, reason: 'already_in_dictionary', existingWordId: held });
      continue;
    }
    const gloss = s.glosses?.[0] ?? null;
    plan.planned.push({
      kind: 'cited',
      wordId: mintId(form, gloss ?? s.pos),
      displayText: form,
      pos: s.pos,
      gloss,
      entryId: s.entry_id,
      uses: usage.get(form)?.uses ?? 0,
    });
    plannedSpellings.add(form);
  }

  // Wiktionary spellings with an entry, whether planned just now or already held under another
  // spelling's citation - a form with an entry is never ALSO seeded as exempt.
  const withEntry = new Set(senses.rows.map((s) => nfc(s.canonical_value)));
  for (const [form, u] of [...usage.entries()].sort((a, b) => b[1].uses - a[1].uses || a[0].localeCompare(b[0]))) {
    if (withEntry.has(form) || plannedSpellings.has(form)) continue;
    const held = heldBySpelling.get(form);
    if (held) {
      plan.skipped.push({ displayText: form, reason: 'already_in_dictionary', existingWordId: held });
      continue;
    }
    const pos = posFromHyphens(form);
    const gloss = commonestGloss(form);
    plan.planned.push({ kind: 'exempt', wordId: mintId(form, gloss ?? pos), displayText: form, pos, gloss, uses: u.uses });
  }
  assignIds(plan.planned, takenIds);
  return plan;
}

/** Final word_ids: the short gloss-based id where it is unique; where several forms share it (the
 * four "nominalizing prefix" o's), each form carrying tone marks or underdots gets them spelled into
 * its id - `o-_dot_low_nominalizing_prefix` for ọ̀- - and only a genuine tie is numbered. Mutates. */
function assignIds(items: AffixSeedItem[], taken: Set<string>): void {
  const byBase = new Map<string, AffixSeedItem[]>();
  for (const i of items) byBase.set(i.wordId, [...(byBase.get(i.wordId) ?? []), i]);
  for (const [base, group] of byBase) {
    for (const item of group) {
      const marks = group.length > 1 || taken.has(base) ? diacriticHint(item.displayText) : '';
      let id = marks ? base.replace('_', `_${marks}_`) : base;
      for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
      taken.add(id);
      item.wordId = id;
    }
  }
}

export interface AffixSeedResult extends AffixSeedPlan {
  written: number;
  failed: Array<AffixSeedItem & { error: string }>;
}

/** Creates each planned entry in its own transaction, with its author's vote - so one bad row is
 * reported and stepped over rather than taking the rest with it. */
export async function applyAffixSeed(pool: pg.Pool, plan: AffixSeedPlan, createdBy: string): Promise<AffixSeedResult> {
  const result: AffixSeedResult = { ...plan, written: 0, failed: [] };
  for (const item of plan.planned) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction(pool, async (client) => {
        await createWordInTransaction(
          client,
          {
            wordId: item.wordId,
            displayText: item.displayText,
            syllables: syllabifyWord(item.displayText),
            definition: item.gloss,
            ...(item.kind === 'cited'
              ? { citation: { entryId: item.entryId as string } }
              : { citation: { exemptReason: EXEMPT_REASON }, pos: item.pos, englishGloss: item.gloss }),
          },
          createdBy,
        );
        await recordAuthoringVote(client, item.wordId, createdBy, { hasComponents: false });
      });
      result.written += 1;
    } catch (err) {
      result.failed.push({ ...item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
