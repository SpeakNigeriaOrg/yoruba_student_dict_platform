// migrateLegacyAudio.mjs
//
// One-off script: registers the pre-existing legacy recordings in
// yoruba-student-dict/content/processed/ (produced by that repo's
// content/parse_word_syllable_audio.py from a single-recording-per-word
// protocol under config.json's "speaker3" - natural pronunciation
// followed immediately by syllable-by-syllable enunciation, in the SAME
// recording, then VAD-split into a whole-word clip plus one clip per
// syllable) into this platform's real utterances/syllable_observations
// tables.
//
// content/processed/output.json maps a word key (e.g. "ile_home", built
// as normalize(word)_normalize(english) by parse_word_syllable_text.py)
// to { displayText, syllables } - verified (see conversation, not
// re-checked by this script) that all 39 of its keys already match a
// real golden_record.word_id exactly, so no fuzzy word matching is done
// here; a word key with no matching golden_record row is skipped with a
// warning rather than guessed at.
//
// Legacy protocol -> new two-take schema mapping:
//   - take 1 = the whole-word clip ({word}.wav) - "recording 1: say the
//     word naturally" in the new UI's terms. No segments.
//   - take 2 = a *logical* container only - there is no single legacy
//     recording of "the whole enunciated pass," just the syllable clips
//     the old pipeline already sliced out - so take 2's own audio_data/
//     duration_s/sample_rate are left null (all nullable columns) and
//     its blob_path is the same deterministic logical identifier
//     registerUtterance.ts would derive, even though nothing is stored
//     there. Its segments carry the real per-syllable clips.
//   - Each segment's start_time_s/end_time_s are 0..(that clip's own
//     duration) - meaningless as an offset into a shared take-2
//     recording (there isn't one here), but consistent with this
//     column's actual meaning: "where this syllable is, within the
//     audio this row's blob/audio_data actually contains."
//   - vad_confidence is left null rather than copying the old script's
//     hardcoded confidence=1.0 (not a real per-segment confidence value,
//     just a constant the old script never varied - more honest as null
//     than as a fabricated precise number).
//
// Speaker: registered under display_name 'speaker3' (yoruba-student-
// dict/config.json's own existing "speakers": ["speaker1","speaker2",
// "speaker3"] roster), with no user_id - this speaker predates the
// platform's user accounts entirely, exactly the case speakers.user_id
// being nullable exists for.
//
// Safety: defaults to a dry run (prints what it would do, then rolls
// back). Pass --apply to actually commit. Idempotent either way - reruns
// upsert the same (word_id, speaker_id, take_number) rows rather than
// duplicating.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migrateLegacyAudio.mjs [--apply] [--content-dir=<path>]

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { orthographyInsensitiveForm, toneInsensitiveForm } from '@yoruba-student-dict-platform/shared';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const contentDirArg = args.find((a) => a.startsWith('--content-dir='));
const CONTENT_DIR = contentDirArg
  ? contentDirArg.slice('--content-dir='.length)
  : path.resolve(process.cwd(), '../yoruba-student-dict/content/processed');

const SPEAKER_DISPLAY_NAME = 'speaker3';

// ---------------------------------------------------------------------
// Minimal WAV parsing - just enough to read sample rate and PCM data
// bytes back out. Walks RIFF chunks rather than assuming fixed offsets,
// since the exact chunk layout these files were written with isn't
// guaranteed (real-world WAV writers vary).
function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = null;
  let bitsPerSample = null;
  let channels = null;
  let dataStart = null;
  let dataSize = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ') {
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataSize = chunkSize;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (sampleRate === null || dataStart === null) throw new Error('missing fmt or data chunk');
  const bytesPerSample = bitsPerSample / 8;
  const durationS = dataSize / (sampleRate * channels * bytesPerSample);
  return { sampleRate, durationS };
}

// macOS (APFS/HFS+) normalizes filenames to NFD on disk; output.json's
// strings are NFC (as written by Python/json). Build a lookup so an NFC
// displayText/syllable can find its real, NFD-normalized directory/file.
function buildNfcToActualNameMap(dirPath) {
  const map = new Map();
  for (const name of readdirSync(dirPath)) {
    map.set(name.normalize('NFC'), name);
  }
  return map;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const outputJsonPath = path.join(CONTENT_DIR, 'output.json');
  const entries = Object.entries(JSON.parse(readFileSync(outputJsonPath, 'utf8')));
  console.log(`Loaded ${entries.length} legacy words from ${outputJsonPath}`);
  console.log(APPLY ? 'Mode: APPLY (will commit)' : 'Mode: DRY RUN (will roll back at the end)');

  const topLevelDirs = buildNfcToActualNameMap(CONTENT_DIR);

  const client = new pg.Client({ connectionString });
  await client.connect();

  let registered = 0;
  let skipped = 0;

  try {
    await client.query('begin');

    const wordRows = await client.query('select word_id from golden_record where word_id = any($1)', [
      entries.map(([wordId]) => wordId),
    ]);
    const existingWordIds = new Set(wordRows.rows.map((r) => r.word_id));

    let speakerResult = await client.query('select speaker_id from speakers where display_name = $1', [SPEAKER_DISPLAY_NAME]);
    let speakerId = speakerResult.rows[0]?.speaker_id;
    if (!speakerId) {
      const inserted = await client.query('insert into speakers (display_name) values ($1) returning speaker_id', [
        SPEAKER_DISPLAY_NAME,
      ]);
      speakerId = inserted.rows[0].speaker_id;
      console.log(`Created speaker '${SPEAKER_DISPLAY_NAME}' (${speakerId})`);
    } else {
      console.log(`Reusing existing speaker '${SPEAKER_DISPLAY_NAME}' (${speakerId})`);
    }

    for (const [wordId, { displayText, syllables }] of entries) {
      if (!existingWordIds.has(wordId)) {
        console.warn(`SKIP ${wordId}: no matching golden_record row`);
        skipped++;
        continue;
      }

      const wordDirName = topLevelDirs.get(displayText.normalize('NFC'));
      if (!wordDirName) {
        console.warn(`SKIP ${wordId}: no processed/ directory for displayText '${displayText}'`);
        skipped++;
        continue;
      }
      const wordDirPath = path.join(CONTENT_DIR, wordDirName);
      const filesInDir = buildNfcToActualNameMap(wordDirPath);

      const wholeWordFileName = filesInDir.get(`${displayText.normalize('NFC')}.wav`);
      if (!wholeWordFileName) {
        console.warn(`SKIP ${wordId}: missing whole-word clip in ${wordDirPath}`);
        skipped++;
        continue;
      }
      const syllableFileNames = syllables.map((s) => filesInDir.get(`${s.normalize('NFC')}.wav`));
      const missingSyllableIndex = syllableFileNames.findIndex((f) => !f);
      if (missingSyllableIndex !== -1) {
        console.warn(
          `SKIP ${wordId}: missing syllable clip for '${syllables[missingSyllableIndex]}' in ${wordDirPath}`,
        );
        skipped++;
        continue;
      }

      const wholeWordBytes = readFileSync(path.join(wordDirPath, wholeWordFileName));
      const wholeWordWav = parseWav(wholeWordBytes);

      const blobPathTake1 = `utterances/${wordId}/${speakerId}/take1.wav`;
      const take1Result = await client.query(
        `insert into utterances (word_id, speaker_id, take_number, blob_path, duration_s, sample_rate, status, audio_data,
                                  recorded_display_text, recorded_syllables)
         values ($1, $2, 1, $3, $4, $5, 'pending_processing', $6, $7, $8)
         on conflict (word_id, speaker_id, take_number) do update set
           blob_path = excluded.blob_path, duration_s = excluded.duration_s, sample_rate = excluded.sample_rate,
           audio_data = excluded.audio_data, recorded_display_text = excluded.recorded_display_text,
           recorded_syllables = excluded.recorded_syllables, recorded_at = now()
         returning utterance_id`,
        [wordId, speakerId, blobPathTake1, wholeWordWav.durationS, wholeWordWav.sampleRate, wholeWordBytes, displayText, syllables],
      );
      const take1UtteranceId = take1Result.rows[0].utterance_id;

      const blobPathTake2 = `utterances/${wordId}/${speakerId}/take2.wav`;
      const take2Result = await client.query(
        `insert into utterances (word_id, speaker_id, take_number, blob_path, status, recorded_display_text, recorded_syllables)
         values ($1, $2, 2, $3, 'segmented', $4, $5)
         on conflict (word_id, speaker_id, take_number) do update set
           blob_path = excluded.blob_path, status = excluded.status,
           recorded_display_text = excluded.recorded_display_text, recorded_syllables = excluded.recorded_syllables,
           recorded_at = now()
         returning utterance_id`,
        [wordId, speakerId, blobPathTake2, displayText, syllables],
      );
      const take2UtteranceId = take2Result.rows[0].utterance_id;

      await client.query('delete from syllable_observations where utterance_id = $1', [take2UtteranceId]);
      for (let position = 0; position < syllables.length; position++) {
        const syllableText = syllables[position];
        const syllableBytes = readFileSync(path.join(wordDirPath, syllableFileNames[position]));
        const syllableWav = parseWav(syllableBytes);
        const segmentBlobPath = `utterances/${wordId}/${speakerId}/take2/syllable${position}.wav`;
        const toneInsensitive = toneInsensitiveForm(syllableText);
        const orthographyInsensitive = orthographyInsensitiveForm(syllableText);
        await client.query(
          `insert into syllable_observations
             (utterance_id, syllable_position, syllable_text, syllable_tone_insensitive, syllable_orthography_insensitive,
              legacy_syllable_key, start_time_s, end_time_s, vad_confidence, blob_path, audio_data)
           values ($1, $2, $3, $4, $5, $5, 0, $6, null, $7, $8)`,
          // legacy_syllable_key: same honest placeholder as
          // registerUtterance.ts (orthography-insensitive form only, NOT
          // the real ported Python generate_syllable_info scheme) - see
          // that file's header for why.
          [
            take2UtteranceId,
            position,
            syllableText,
            toneInsensitive,
            orthographyInsensitive,
            syllableWav.durationS,
            segmentBlobPath,
            syllableBytes,
          ],
        );
      }

      console.log(`OK ${wordId} (${displayText}): take1 ${take1UtteranceId}, take2 ${take2UtteranceId} (${syllables.length} syllables)`);
      registered++;
    }

    if (APPLY) {
      await client.query('commit');
      console.log(`\nCommitted. ${registered} word(s) registered, ${skipped} skipped.`);
    } else {
      await client.query('rollback');
      console.log(`\nDry run complete (rolled back). ${registered} word(s) would be registered, ${skipped} would be skipped.`);
      console.log('Re-run with --apply to commit.');
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
