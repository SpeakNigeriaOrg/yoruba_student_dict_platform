// upstreamPublishCheck.mjs
//
// Reports how much of what is about to be published still matches the Wiktionary
// etymologies it cites. Shared by exportGameContent.mjs and publishToR2.mjs so
// the two cannot disagree about what was verified.
//
// ---------------------------------------------------------------------------
// Why this WARNS and does not drop, unlike the stale-recording check
// ---------------------------------------------------------------------------
// Those two scripts already exclude any recording whose recorded_display_text no
// longer matches the golden spelling, because that recording is a pronunciation of
// a word we no longer publish - it is wrong content, and shipping it would mislead
// a learner directly.
//
// Upstream drift is not that. A student entry's spelling and student definition
// were written and validated by people here; the pin records what Wiktionary said
// at the time, not what we assert. Wiktionary copy-editing a gloss afterwards does
// not make our definition wrong, and dropping a word from the game over it would
// remove correct, human-validated content for a reason no learner shares.
//
// What drift does mean is that a citation may no longer describe what it claims,
// which is a REVIEW signal - the curator drift queue exists for it. So the right
// thing at publish time is to say plainly how much is unverified rather than to
// either hide it or act on it. --strict-upstream is available for a release where
// that judgement should be someone's explicit choice.
//
// The counts are printed even when everything is clean, because "0 drifted" and
// "never checked" look identical in a log that only speaks up on problems.

import { reconcileUpstream } from '../api/dist/handlers/reconcileUpstream.js';

/** @returns {Promise<{ok: boolean, drifted: number}>} */
export async function reportUpstreamHealth(pool, { strict = false } = {}) {
  let result;
  try {
    result = await reconcileUpstream(pool);
  } catch (err) {
    // Never the reason a publish fails: this is a report about the content, not
    // part of producing it.
    console.warn(`      could not check upstream citations: ${err instanceof Error ? err.message : err}`);
    return { ok: true, drifted: 0 };
  }

  const { counts, items, exempt, uncited } = result;
  console.log(
    `      ${counts.unchanged} cited entr${counts.unchanged === 1 ? 'y' : 'ies'} still match Wiktionary` +
      `, ${exempt} exempt, ${uncited} not linked yet`,
  );

  if (items.length === 0) return { ok: true, drifted: 0 };

  console.log(`      ${items.length} citation(s) have drifted:`);
  for (const item of items) {
    const detail =
      item.kind === 're_identified'
        ? `moved to ${item.proposedEntryId}`
        : item.kind === 'disappeared'
          ? 'no longer in the corpus'
          : `content changed (${item.pin.glosses.join('; ')} -> ${(item.current?.glosses ?? []).join('; ')})`;
    console.log(`        ${item.wordId} (${item.displayText}): ${item.kind} - ${detail}`);
  }
  console.log('      Their spelling and student definition are unaffected and are still being published.');
  console.log('      Resolve them in the curator drift queue.');

  if (strict) {
    console.error(`\nRefusing to publish with ${items.length} unreconciled citation(s) (--strict-upstream).`);
    return { ok: false, drifted: items.length };
  }
  return { ok: true, drifted: items.length };
}
