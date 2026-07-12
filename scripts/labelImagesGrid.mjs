// labelImagesGrid.mjs
//
// Visual alternative to labelPendingImages.mjs's search-based CLI: a tiny
// local web server (Node's built-in http only, no new dependencies - this
// is a one-off tool, not meant to persist) showing the current word
// needing an image at the top, and a thumbnail grid of every remaining
// file in yoruba-student-dict/content/pending_images/ below. Click a
// thumbnail to assign it to the current word (moves the file into
// content/staged/images/{style}/{word_id}.png, the exact layout
// migrateStagedImages.mjs already imports) and auto-advance to the next
// word. Skip/Prev/Next move through the word queue without assigning.
//
// This script never touches Postgres beyond reading golden_record/
// word_images to build the initial "words still missing an image" queue.
// Run migrateStagedImages.mjs --apply afterward to register what you've
// assigned, then publishToR2.mjs --apply to publish.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/labelImagesGrid.mjs [--repo-dir=<path>] [--art-style=cartoon] [--port=4321]

import { readdirSync, renameSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import pg from 'pg';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const found = args.find((a) => a.startsWith(`--${flag}=`));
  return found ? found.slice(flag.length + 3) : fallback;
}
const REPO_DIR = path.resolve(process.cwd(), argValue('repo-dir', '../yoruba-student-dict'));
const ART_STYLE = argValue('art-style', 'cartoon');
const PORT = parseInt(argValue('port', '4321'), 10);
const PENDING_DIR = path.join(REPO_DIR, 'content', 'pending_images');
const STAGED_DIR = path.join(REPO_DIR, 'content', 'staged', 'images', ART_STYLE);

function listPendingImages() {
  return readdirSync(PENDING_DIR)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort();
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

  const client = new pg.Client({ connectionString });
  await client.connect();
  const words = (
    await client.query(`
      select w.word_id, w.display_text, w.definition
      from golden_record w
      where not exists (select 1 from word_images wi where wi.word_id = w.word_id and wi.art_style = $1)
      order by w.word_id
    `, [ART_STYLE])
  ).rows;
  await client.end();

  if (words.length === 0) {
    console.log(`Every word already has a "${ART_STYLE}" image - nothing to do.`);
    return;
  }
  console.log(`${words.length} word(s) still need a "${ART_STYLE}" image.`);

  let queueIndex = 0;

  function currentState() {
    return {
      word: words[queueIndex] ?? null,
      queueIndex,
      queueLength: words.length,
      pendingImages: listPendingImages(),
    };
  }

  function sendJson(res, obj, status = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, currentState());
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/pending-image/')) {
        const filename = decodeURIComponent(url.pathname.slice('/pending-image/'.length));
        // Only ever serve a file that's genuinely still in the pending
        // list right now - never trust the path segment directly (no
        // path.join with unvalidated input reaching the filesystem).
        if (!listPendingImages().includes(filename)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const filePath = path.join(PENDING_DIR, filename);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': statSync(filePath).size });
        createReadStream(filePath).pipe(res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/assign') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { filename } = JSON.parse(body || '{}');
        const pending = listPendingImages();
        if (!pending.includes(filename)) {
          sendJson(res, { error: 'that file is no longer in the pending list' }, 400);
          return;
        }
        const word = words[queueIndex];
        if (!word) {
          sendJson(res, { error: 'no current word (queue finished)' }, 400);
          return;
        }
        renameSync(path.join(PENDING_DIR, filename), path.join(STAGED_DIR, `${word.word_id}.png`));
        console.log(`Assigned ${filename} -> ${word.word_id}.png`);
        queueIndex = Math.min(queueIndex + 1, words.length);
        sendJson(res, currentState());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/skip') {
        queueIndex = Math.min(queueIndex + 1, words.length);
        sendJson(res, currentState());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/prev') {
        queueIndex = Math.max(queueIndex - 1, 0);
        sendJson(res, currentState());
        return;
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      console.error(err);
      sendJson(res, { error: err.message }, 500);
    }
  });

  // Bound explicitly to loopback only - this server has an
  // unauthenticated file-moving API, and Node's default (no host arg)
  // listens on all interfaces, which would expose it to the whole LAN.
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`Labeling UI running at ${url}`);
    execFile('open', [url], () => {});
  });
}

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Image labeling</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; background: #111; color: #eee; }
  #word-bar { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; padding: 1rem; background: #222; border-radius: 8px; position: sticky; top: 0; }
  #word-bar h2 { margin: 0; }
  #word-bar .gloss { color: #aaa; }
  button { font-size: 1rem; padding: 0.5rem 1rem; cursor: pointer; border: none; border-radius: 6px; background: #444; color: #eee; }
  button:hover { background: #555; }
  #skip-btn { background: #664; }
  #progress { margin-left: auto; color: #aaa; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .thumb { cursor: pointer; border: 2px solid transparent; border-radius: 6px; overflow: hidden; background: #222; aspect-ratio: 1; }
  .thumb:hover { border-color: #4a9; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  #done { font-size: 1.3rem; padding: 2rem; text-align: center; }
</style>
</head>
<body>
  <div id="word-bar">
    <div>
      <h2 id="word-id">…</h2>
      <div class="gloss" id="word-gloss"></div>
    </div>
    <button id="prev-btn">&larr; Prev</button>
    <button id="skip-btn">Skip</button>
    <div id="progress"></div>
  </div>
  <div id="grid"></div>
  <div id="done" style="display:none">All words labeled or skipped. Re-run this script to see any that are still missing.</div>

<script>
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function refresh() {
  const state = await fetchJson('/api/state');
  render(state);
}

function render(state) {
  if (!state.word) {
    document.getElementById('word-bar').style.display = 'none';
    document.getElementById('grid').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    return;
  }
  document.getElementById('word-id').textContent = state.word.word_id + ' — ' + (state.word.display_text || '');
  document.getElementById('word-gloss').textContent = state.word.definition || '(no definition)';
  document.getElementById('progress').textContent = (state.queueIndex + 1) + ' / ' + state.queueLength;

  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  for (const filename of state.pendingImages) {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.src = '/pending-image/' + encodeURIComponent(filename);
    img.loading = 'lazy';
    div.appendChild(img);
    div.onclick = async () => {
      const result = await fetchJson('/api/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      render(result);
    };
    grid.appendChild(div);
  }
}

document.getElementById('skip-btn').onclick = async () => render(await fetchJson('/api/skip', { method: 'POST' }));
document.getElementById('prev-btn').onclick = async () => render(await fetchJson('/api/prev', { method: 'POST' }));

refresh();
</script>
</body>
</html>`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
