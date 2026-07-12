// labelPendingImages.mjs
//
// One-off, interactive CLI for matching yoruba-student-dict's ~240 still-
// unlabeled generated images (content/pending_images/*.png, generic
// filenames like "z-image_00003_.png") to real golden_record word_ids.
// Deliberately NOT a persistent web UI - just a terminal loop, since this
// is a one-time backlog to clear, not an ongoing workflow.
//
// For each pending image: opens it in the OS's default viewer (macOS
// `open`), then prompts you to search golden_record by spelling or
// English gloss and pick a match. On confirmation, MOVES the file into
// content/staged/images/{style}/{word_id}.png - the exact layout
// migrateStagedImages.mjs already knows how to import into Postgres.
// This script never touches the database itself; run
// migrateStagedImages.mjs --apply afterward to actually register what
// you've labeled, then publishToR2.mjs --apply to publish.
//
// Commands at each prompt:
//   <search text>   - filter golden_record by spelling/definition substring
//   <number>        - pick a filtered result by its printed index
//   discard         - move the image to content/pending_images_discarded/
//                     (out of the queue, not deleted, for images that
//                     aren't usable at all - wrong subject, low quality, etc.)
//   skip            - leave it in pending_images/, move to the next one
//                     (will be shown again next run)
//   quit            - stop early (already-labeled/discarded files this run
//                     stay moved; nothing in progress is lost)
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/labelPendingImages.mjs [--repo-dir=<path>] [--art-style=cartoon]

import { readdirSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pg from 'pg';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const found = args.find((a) => a.startsWith(`--${flag}=`));
  return found ? found.slice(flag.length + 3) : fallback;
}
const REPO_DIR = path.resolve(process.cwd(), argValue('repo-dir', '../yoruba-student-dict'));
const ART_STYLE = argValue('art-style', 'cartoon');
const PENDING_DIR = path.join(REPO_DIR, 'content', 'pending_images');
const DISCARDED_DIR = path.join(REPO_DIR, 'content', 'pending_images_discarded');
const STAGED_DIR = path.join(REPO_DIR, 'content', 'staged', 'images', ART_STYLE);

function openImage(filePath) {
  execFile('open', [filePath], (err) => {
    if (err) console.warn(`  (couldn't auto-open ${filePath}: ${err.message} - open it manually)`);
  });
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  if (!existsSync(PENDING_DIR)) {
    console.error(`No pending_images directory at ${PENDING_DIR}`);
    process.exit(1);
  }
  mkdirSync(STAGED_DIR, { recursive: true });
  mkdirSync(DISCARDED_DIR, { recursive: true });

  const client = new pg.Client({ connectionString });
  await client.connect();
  const words = (await client.query('select word_id, display_text, definition from golden_record order by word_id')).rows;
  await client.end();

  const alreadyLabeled = new Set(
    existsSync(STAGED_DIR) ? readdirSync(STAGED_DIR).map((f) => f.replace(/\.png$/i, '')) : [],
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });

  let labeledCount = 0;
  let discardedCount = 0;
  let skippedCount = 0;

  function search(term) {
    const t = term.trim().toLowerCase();
    if (!t) return [];
    return words.filter(
      (w) =>
        w.word_id.toLowerCase().includes(t) ||
        (w.display_text ?? '').toLowerCase().includes(t) ||
        (w.definition ?? '').toLowerCase().includes(t),
    );
  }

  const pendingFiles = readdirSync(PENDING_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
  console.log(`${pendingFiles.length} unlabeled image(s) found. ${alreadyLabeled.size} word(s) already have a "${ART_STYLE}" image.\n`);

  for (const filename of pendingFiles) {
    const filePath = path.join(PENDING_DIR, filename);
    console.log(`\n=== ${filename} (${pendingFiles.indexOf(filename) + 1}/${pendingFiles.length}) ===`);
    openImage(filePath);

    let lastResults = [];
    let handled = false;
    while (!handled) {
      const answer = (await rl.question('  word search / number / discard / skip / quit > ')).trim();

      if (answer === 'quit') {
        console.log(`\nStopped early. Labeled ${labeledCount}, discarded ${discardedCount}, skipped ${skippedCount}.`);
        rl.close();
        return;
      }
      if (answer === 'skip') {
        skippedCount++;
        handled = true;
        continue;
      }
      if (answer === 'discard') {
        renameSync(filePath, path.join(DISCARDED_DIR, filename));
        console.log(`  -> discarded to ${DISCARDED_DIR}`);
        discardedCount++;
        handled = true;
        continue;
      }

      if (/^\d+$/.test(answer)) {
        const idx = parseInt(answer, 10) - 1;
        const picked = lastResults[idx];
        if (!picked) {
          console.log('  no such result number - search again');
          continue;
        }
        if (alreadyLabeled.has(picked.word_id)) {
          const confirm = await rl.question(`  "${picked.word_id}" already has a ${ART_STYLE} image - overwrite it? (y/n) `);
          if (confirm.trim().toLowerCase() !== 'y') continue;
        }
        const destPath = path.join(STAGED_DIR, `${picked.word_id}.png`);
        renameSync(filePath, destPath);
        alreadyLabeled.add(picked.word_id);
        console.log(`  -> labeled as "${picked.word_id}" (${picked.display_text}: ${picked.definition ?? ''})`);
        labeledCount++;
        handled = true;
        continue;
      }

      lastResults = search(answer);
      if (lastResults.length === 0) {
        console.log('  no matches - try another search term');
      } else {
        lastResults.slice(0, 15).forEach((w, i) => {
          const flag = alreadyLabeled.has(w.word_id) ? ' [has image]' : '';
          console.log(`   ${i + 1}. ${w.word_id} - "${w.display_text}": ${w.definition ?? ''}${flag}`);
        });
        if (lastResults.length > 15) console.log(`   ...and ${lastResults.length - 15} more - refine your search`);
      }
    }
  }

  rl.close();
  console.log(`\nDone. Labeled ${labeledCount}, discarded ${discardedCount}, skipped ${skippedCount}.`);
  console.log('Next: node scripts/migrateStagedImages.mjs --apply, then node scripts/publishToR2.mjs --apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
