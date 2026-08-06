// handlers/reconcileUpstream.ts
//
// Detects Wiktionary changing underneath the entries that cite it.
//
// The pin (0014) makes an entry independent of upstream: it renders and reasons
// from a copy taken when a human validated it, so an edit on Wiktionary can never
// silently change what we assert. That is the guarantee. This is its other half -
// without a way to LOOK for drift, "independent of upstream" quietly becomes
// "unaware of upstream", and a citation slowly stops describing anything real.
//
// ---------------------------------------------------------------------------
// The four states, and why the id is the fast path rather than the mechanism
// ---------------------------------------------------------------------------
// kaikki-yoruba mints an entry's id from its FIRST sense's wiktextract id, and
// that suffix encodes sense content: of 529 word+pos groups with several
// etymologies, only 3 have colliding suffixes. So an upstream gloss edit tends to
// change the ID rather than leave a stable id pointing at changed content - the
// link breaks LOUDLY. That is the safer failure mode, and it means the branch
// that fires in practice is "re-identified", found by content, not "the id is
// still there but says something different".
//
// So the content fingerprint does the real work and the id is an optimisation.
// Both are checked, because either can move independently.
//
// ---------------------------------------------------------------------------
// Gloss ORDER is not drift
// ---------------------------------------------------------------------------
// 20.7% of entries have more than one sense, and only the first sense's id names
// the entry. A Wiktionary editor reordering senses inside one etymology therefore
// moves our cited id while changing nothing about what the etymology means.
// pinContentFingerprint compares glosses as a SET for exactly this reason; see
// shared/src/upstreamPin.ts.

import { buildPin, pinContentFingerprint, type UpstreamPin } from '@yoruba-student-dict-platform/shared';
import type { Queryable } from '../db.js';
import { loadAllSenses, loadSenseByEntryId } from '../kaikkiData.js';

export type DriftKind =
  /** The cited etymology is still there and still says the same thing. */
  | 'unchanged'
  /** The id resolves, but the etymology's content changed. A curator judges
   * whether our entry should follow. */
  | 'content_changed'
  /** The id is gone, but an etymology elsewhere in the corpus carries exactly the
   * pinned content - a renumber or re-identification. A re-link is proposed. */
  | 're_identified'
  /** The id is gone and nothing matches the pinned content. Hard flag: this is
   * the one state where an entry's identity has no upstream referent at all. */
  | 'disappeared';

export interface DriftItem {
  wordId: string;
  displayText: string;
  citedEntryId: string;
  kind: DriftKind;
  /** What upstream said when a human validated it. */
  pin: UpstreamPin;
  /** What upstream says now - for content_changed and re_identified. */
  current?: UpstreamPin;
  /** For re_identified: the etymology now carrying the pinned content. */
  proposedEntryId?: string;
}

/** A word recorded as having no upstream entry. */
export interface ExemptItem {
  wordId: string;
  displayText: string;
  exemptReason: string;
}

export interface ReconcileResult {
  /** Only the items needing attention. 'unchanged' is counted, never listed -
   * a queue of things that are fine is a queue nobody reads. */
  items: DriftItem[];
  counts: Record<DriftKind, number>;
  /** Words with no citation at all, and words explicitly exempt, are outside
   * this check by construction. Reported so a total is never mistaken for
   * "every word was verified against upstream". */
  exempt: number;
  uncited: number;
  /** The exempt words themselves, not just the count.
   *
   * An exempt citation is not a gap - it IS the durable record that a word awaits a Wiktionary
   * entry, which is what the volunteer word-request path relies on. But a record nobody can find
   * is not a record: this was counted and never named, so the day Wiktionary gains the entry
   * there was nothing to act on. Re-linking is already one click (repinUpstream); this is what
   * was missing in front of it. */
  exemptItems: ExemptItem[];
}

interface CitationRow {
  word_id: string;
  display_text: string;
  entry_id: string | null;
  exempt_reason: string | null;
  pin: UpstreamPin;
}

export async function reconcileUpstream(client: Queryable): Promise<ReconcileResult> {
  const { rows } = await client.query<CitationRow>(
    `select c.word_id, g.display_text, c.entry_id, c.exempt_reason, c.pin
     from upstream_citations c
     join golden_record g on g.word_id = c.word_id
     order by c.word_id`,
  );

  const uncitedResult = await client.query<{ n: number }>(
    `select count(*)::int n from golden_record g
     where not exists (select 1 from upstream_citations c where c.word_id = g.word_id)`,
  );

  const counts: Record<DriftKind, number> = { unchanged: 0, content_changed: 0, re_identified: 0, disappeared: 0 };
  const items: DriftItem[] = [];
  const exemptItems: ExemptItem[] = [];

  /** Built once and only if something actually needs re-finding. Scanning the
   * whole corpus is the accepted small-corpus tradeoff this codebase already
   * makes for search, but there is no reason to pay it when every id resolves -
   * which is the normal case. */
  let byContent: Map<string, string> | null = null;
  const contentIndex = async (): Promise<Map<string, string>> => {
    if (byContent) return byContent;
    byContent = new Map();
    for (const sense of await loadAllSenses(client)) {
      if (!sense.entryId) continue;
      const key = pinContentFingerprint(buildPin(sense));
      // First writer wins. A duplicate means two etymologies are indistinguishable
      // by content, so there is no basis for preferring either; proposing the
      // first is honest as long as a human confirms the re-link, which they do.
      if (!byContent.has(key)) byContent.set(key, sense.entryId);
    }
    return byContent;
  };

  for (const row of rows) {
    if (!row.entry_id) {
      exemptItems.push({
        wordId: row.word_id,
        displayText: row.display_text,
        // 0014's check constraint makes this non-null whenever entry_id is null, so the fallback
        // is unreachable rather than a real case - it exists so a hand-edited row renders.
        exemptReason: row.exempt_reason ?? 'no reason recorded',
      });
      continue;
    }

    const pinnedFingerprint = pinContentFingerprint(row.pin);
    const sense = await loadSenseByEntryId(client, row.entry_id);

    if (sense) {
      const current = buildPin(sense);
      if (pinContentFingerprint(current) === pinnedFingerprint) {
        counts.unchanged += 1;
        continue;
      }
      counts.content_changed += 1;
      items.push({
        wordId: row.word_id,
        displayText: row.display_text,
        citedEntryId: row.entry_id,
        kind: 'content_changed',
        pin: row.pin,
        current,
      });
      continue;
    }

    const match = (await contentIndex()).get(pinnedFingerprint);
    if (match) {
      counts.re_identified += 1;
      const moved = await loadSenseByEntryId(client, match);
      items.push({
        wordId: row.word_id,
        displayText: row.display_text,
        citedEntryId: row.entry_id,
        kind: 're_identified',
        pin: row.pin,
        proposedEntryId: match,
        ...(moved ? { current: buildPin(moved) } : {}),
      });
      continue;
    }

    counts.disappeared += 1;
    items.push({
      wordId: row.word_id,
      displayText: row.display_text,
      citedEntryId: row.entry_id,
      kind: 'disappeared',
      pin: row.pin,
    });
  }

  return { items, counts, exempt: exemptItems.length, exemptItems, uncited: uncitedResult.rows[0].n };
}
