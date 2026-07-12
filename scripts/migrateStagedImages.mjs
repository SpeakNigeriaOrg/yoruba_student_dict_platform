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
// Each file registers as variant_number 1 for its (word_id, art_style)
// pair - rerunning after a file changes on disk will just re-upload the
// same slot (upsert on conflict), not create a duplicate variant.
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

        const blobPath = `images/${style}/${wordId}_1.png`;
        console.log(`${apply ? 'REGISTER' : '[dry-run] would register'} ${style}/${wordId} (variant 1, ${imageData.length} bytes)`);

        if (apply) {
          await client.query(
            `insert into word_images (word_id, art_style, variant_number, image_data, content_type, blob_path)
             values ($1, $2, 1, $3, 'image/png', $4)
             on conflict (word_id, art_style, variant_number)
             do update set image_data = excluded.image_data, blob_path = excluded.blob_path`,
            [wordId, style, imageData, blobPath],
          );
        }
        registered++;
      }
    }

    console.log('');
    console.log(`Summary: ${registered} image(s) ${apply ? 'registered' : 'would be registered'}, ${skippedUnknownWord} skipped (unknown word_id), ${skippedEmpty} skipped (empty file).`);

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
