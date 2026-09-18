// migrateStagedImages.mjs
//
// One-off script: registers the pre-existing, already-labeled cartoon
// images in yoruba-student-dict/content/staged/images/{art_style}/ (e.g.
// content/staged/images/cartoon/ewa_beauty.png) into this platform's real
// word_images table (0010_word_images.sql).
//
// Only images/{style}/{word_id}.png are handled here - each such file is
// already named exactly after a real golden_record.word_id, so no fuzzy
// matching is needed (unlike the syllable-to-word linking problem
// migrateSpeaker1And2.mjs had to solve). A filename that doesn't match any
// current golden_record.word_id is skipped with a warning rather than
// guessed at.
//
// Explicitly NOT handled here: content/pending_images/ (296 files as of
// this writing, e.g. "z-image_00003_.png") - these were bulk-generated
// but never labeled with a word_id, so there is no reliable, non-visual
// way to match them to words. Labeling those is a separate, later task
// (see this script's own header note in the session's plan file).
//
// word_images allows any number of variants per (word_id, art_style) -
// accept_image (imagegen/db.py) always adds a new one rather than
// overwriting, so this script can't rely on an on-conflict upsert to stay
// idempotent the way it used to (that would also risk clobbering a
// variant a human has since accepted via review.py at the same slot).
// Idempotency here is instead keyed on blob_path: each staged file gets
// the deterministic path images/{style}/{wordId}.png, and a rerun that
// finds a row already registered under that exact path skips it rather
// than inserting a second copy as a new variant.
//
// Safety: defaults to a dry run (prints what it would do, then rolls
// back). Pass --apply to actually commit. Idempotent either way.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrateStagedImages.mjs [--apply] [--images-dir=<path>]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const imagesDirArg = args.find((a) => a.startsWith('--images-dir='));
const imagesDir = imagesDirArg
  ? imagesDirArg.slice('--images-dir='.length)
  : path.join(process.cwd(), '..', 'yoruba-student-dict', 'content', 'staged', 'images');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const styleDirs = readdirSync(imagesDir).filter((name) =>
    statSync(path.join(imagesDir, name)).isDirectory(),
  );
  console.log(`Found art style directories: ${styleDirs.join(', ') || '(none)'}`);

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const { rows: wordRows } = await client.query('select word_id from golden_record');
    const knownWordIds = new Set(wordRows.map((r) => r.word_id));

    await client.query('begin');

    let registered = 0;
    let skippedUnknownWord = 0;
    let skippedEmpty = 0;
    let skippedAlreadyRegistered = 0;

    for (const style of styleDirs) {
      const styleDir = path.join(imagesDir, style);
      const files = readdirSync(styleDir).filter((f) => f.toLowerCase().endsWith('.png'));

      for (const filename of files) {
        const wordId = filename.replace(/\.png$/i, '');
        const filePath = path.join(styleDir, filename);

        if (!knownWordIds.has(wordId)) {
          console.warn(`SKIP ${style}/${filename}: no matching golden_record.word_id "${wordId}"`);
          skippedUnknownWord++;
          continue;
        }

        const imageData = readFileSync(filePath);
        if (imageData.length === 0) {
          console.warn(`SKIP ${style}/${filename}: empty file`);
          skippedEmpty++;
          continue;
        }

        const blobPath = `images/${style}/${wordId}.png`;
        const { rows: existingRows } = await client.query(
          'select 1 from word_images where word_id = $1 and art_style = $2 and blob_path = $3',
          [wordId, style, blobPath],
        );
        if (existingRows.length > 0) {
          console.log(`SKIP ${style}/${wordId}: already registered (blob_path ${blobPath})`);
          skippedAlreadyRegistered++;
          continue;
        }

        console.log(`${apply ? 'REGISTER' : '[dry-run] would register'} ${style}/${wordId} (${imageData.length} bytes)`);

        if (apply) {
          await client.query(
            `insert into word_images (word_id, art_style, variant_number, image_data, content_type, blob_path)
             select $1, $2, coalesce(max(variant_number), 0) + 1, $3, 'image/png', $4
             from word_images where word_id = $1 and art_style = $2`,
            [wordId, style, imageData, blobPath],
          );
        }
        registered++;
      }
    }

    console.log('');
    console.log(`Summary: ${registered} image(s) ${apply ? 'registered' : 'would be registered'}, ${skippedUnknownWord} skipped (unknown word_id), ${skippedEmpty} skipped (empty file), ${skippedAlreadyRegistered} skipped (already registered).`);

    if (apply) {
      await client.query('commit');
      console.log('Committed.');
    } else {
      await client.query('rollback');
      console.log('Dry run only - rolled back. Pass --apply to commit.');
    }
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
