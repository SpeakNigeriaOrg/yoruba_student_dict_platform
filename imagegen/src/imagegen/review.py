# Local review UI for candidates/ produced by generate.py - the pick-best-
# of-N (or reject-and-requeue) step. Deliberately the Python sibling of
# scripts/labelImagesGrid.mjs's approach: a tiny local HTTP server (stdlib
# only), no framework, bound to loopback only since it exposes an
# unauthenticated "accept into the database" API.
#
# Usage:
#   DATABASE_URL=postgres://... python -m imagegen.review [--art-style cartoon] [--port 4322]
#
# For each word_id under candidates/{art_style}/ that has a manifest.json
# (i.e. generation finished): shows the word's gloss and its N candidate
# images side by side, plus any images already accepted for this word+style
# (a word can hold any number of accepted variants - see db.py).
#   - click one or more thumbnails to select them, then "Accept selected"
#     -> each selected candidate is added as a NEW variant (db.accept_image
#     never overwrites an existing one), the whole
#     candidates/{art_style}/{word_id}/ dir is deleted, and the queue
#     advances. Picking several good candidates from one batch in a single
#     pass is the point - no need to revisit the word or regenerate just to
#     accept a second or third good image.
#   - each already-accepted image has its own small delete button, for
#     retiring a bad variant - this IS destructive (no version history) and
#     asks for confirmation; accepting new candidates never touches these.
#   - Reject all  -> deletes the candidates dir without writing to the
#     database. The word has no *new* candidates queued again until the
#     next generate.py run; any already-accepted images are untouched.
#   - Skip / Prev  -> move the review queue without touching anything on
#     disk or in the database.
#
# Runs as a ThreadingHTTPServer, not the stdlib default HTTPServer, and
# every connection gets a socket timeout - both exist for the same reason:
# a plain single-threaded HTTPServer handles exactly one connection at a
# time, so if any ONE of them gets stuck (a client that opens a connection
# and goes away without a clean close, a slow/dead network path - browsers
# and curl can both do this), the entire server freezes for every other
# request, including the page a reviewer is actively looking at, with no
# error shown anywhere. That's exactly what happened here in practice, on
# top of - not instead of - the DB-staleness hang db.py's connect() and
# call_db() below already guard against; both are the same underlying
# class of bug (one stuck thing silently blocks everything) at different
# layers (the DB connection vs. the HTTP connections themselves).
# call_db's psycopg connection is NOT safe to touch from two threads at
# once, so every handler serializes on STATE_LOCK.
import argparse
import http.server
import json
import shutil
import threading
from pathlib import Path
from urllib.parse import urlparse

import psycopg

from . import config, db, styles

CANDIDATES_DIR = Path(__file__).resolve().parent.parent.parent / "candidates"


def list_queue(art_style_dir: Path) -> list[str]:
    if not art_style_dir.exists():
        return []
    return sorted(
        p.name for p in art_style_dir.iterdir() if p.is_dir() and (p / "manifest.json").exists()
    )


def make_handler(art_style: str, art_style_dir: Path, conn):
    style = styles.get(art_style)
    state = {"queue": list_queue(art_style_dir), "index": 0}
    # Mutable holder, not a bare variable - reconnecting has to replace
    # the actual connection object a closure captured by reference, and a
    # plain local can't be reassigned from call_db without `nonlocal`
    # sprawled across every call site.
    conn_holder = {"conn": conn}
    # do_GET/do_POST each hold this for their whole body (see module
    # docstring) - the psycopg connection and the state/queue dict are
    # shared across every request thread and aren't safe for concurrent
    # use. This only serializes the app logic itself, which is fast; it
    # does NOT block the ThreadingHTTPServer from accepting and starting
    # other connections concurrently, which is the actual point of being
    # threaded at all.
    state_lock = threading.Lock()

    def call_db(fn, *args, **kwargs):
        """Runs fn(conn, *args, **kwargs); if the connection has gone
        stale (an interactive review session can sit idle for a long
        time - see db.connect()'s docstring on why that matters),
        reconnects once and retries, rather than hanging the entire
        (single-threaded) server or leaving the UI dead with no way to
        recover short of restarting the process."""
        try:
            return fn(conn_holder["conn"], *args, **kwargs)
        except psycopg.Error as exc:
            print(f"  (DB error ({exc}) - reconnecting and retrying once)")
            try:
                conn_holder["conn"].close()
            except Exception:  # noqa: BLE001 - already broken, closing is best-effort
                pass
            conn_holder["conn"] = db.connect()
            return fn(conn_holder["conn"], *args, **kwargs)

    def current_word_dir():
        if state["index"] >= len(state["queue"]):
            return None
        return art_style_dir / state["queue"][state["index"]]

    def current_state():
        word_dir = current_word_dir()
        word_id = state["queue"][state["index"]] if word_dir else None
        # encoding="utf-8" matters: manifest.json is written utf-8/non-ascii
        # (Yoruba diacritics) by generate.py, and Windows' default locale
        # encoding can't represent that - see generate.py's effective_gloss.
        manifest = json.loads((word_dir / "manifest.json").read_text(encoding="utf-8")) if word_dir else None
        variants = sorted(p.name for p in word_dir.glob("v*.png")) if word_dir else []
        existing_images = call_db(db.list_images, word_id, art_style) if word_id else []
        return {
            "index": state["index"],
            "queueLength": len(state["queue"]),
            "wordId": word_id,
            "manifest": manifest,
            "variants": variants,
            "styleLabel": style.label,
            "reviewRubric": style.review_rubric,
            "existingImages": [
                {"imageId": str(img["image_id"]), "variantNumber": img["variant_number"]}
                for img in existing_images
            ],
        }

    class Handler(http.server.BaseHTTPRequestHandler):
        def _send_json(self, obj, status=200):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            # See module docstring on why every request serializes on
            # state_lock (shared conn/state across request threads) while
            # still letting the ThreadingHTTPServer accept and start other
            # connections concurrently.
            with state_lock:
                self._handle_get()

        def _handle_get(self):
            path = urlparse(self.path).path
            if path == "/":
                body = PAGE_HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/state":
                self._send_json(current_state())
                return
            if path.startswith("/candidate-image/"):
                filename = path[len("/candidate-image/"):]
                word_dir = current_word_dir()
                # Only ever serve a file from the CURRENT word's own directory,
                # never an arbitrary path built from client input.
                if word_dir is None or filename not in {p.name for p in word_dir.glob("v*.png")}:
                    self.send_response(404)
                    self.end_headers()
                    return
                data = (word_dir / filename).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if path.startswith("/existing-image/"):
                # image_id is a DB-generated UUID, not a client-supplied
                # filesystem path - no traversal risk the way
                # /candidate-image/ has to guard against.
                image_id = path[len("/existing-image/"):]
                data = call_db(db.get_image, image_id)
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            with state_lock:
                self._handle_post()

        def _handle_post(self):
            path = urlparse(self.path).path
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw or b"{}")

            if path == "/api/accept":
                word_dir = current_word_dir()
                if word_dir is None:
                    self._send_json({"error": "queue finished"}, 400)
                    return
                variants = payload.get("variants")
                if not variants or not isinstance(variants, list):
                    self._send_json({"error": "no variants selected"}, 400)
                    return
                available = {p.name for p in word_dir.glob("v*.png")}
                if not all(v in available for v in variants):
                    self._send_json({"error": "no such variant"}, 400)
                    return
                word_id = state["queue"][state["index"]]
                # Each accept is purely additive (see db.accept_image) - no
                # overwrite risk, so no confirmation/re-check needed here
                # the way the old single-slot upsert required.
                for variant in variants:
                    call_db(db.accept_image, word_id, art_style, (word_dir / variant).read_bytes())
                shutil.rmtree(word_dir)
                print(f"Accepted {len(variants)} image(s) for {word_id}: {', '.join(variants)}")
                state["index"] = min(state["index"] + 1, len(state["queue"]))
                self._send_json(current_state())
                return

            if path == "/api/delete-existing":
                image_id = payload.get("imageId")
                if not image_id:
                    self._send_json({"error": "imageId required"}, 400)
                    return
                call_db(db.delete_image, image_id)
                print(f"Deleted accepted image {image_id}")
                self._send_json(current_state())
                return

            if path == "/api/reject":
                word_dir = current_word_dir()
                if word_dir is not None:
                    word_id = state["queue"][state["index"]]
                    shutil.rmtree(word_dir)
                    print(f"Rejected all candidates for {word_id} - will be regenerated on next run")
                state["index"] = min(state["index"] + 1, len(state["queue"]))
                self._send_json(current_state())
                return

            if path == "/api/skip":
                state["index"] = min(state["index"] + 1, len(state["queue"]))
                self._send_json(current_state())
                return

            if path == "/api/prev":
                state["index"] = max(state["index"] - 1, 0)
                self._send_json(current_state())
                return

            self.send_response(404)
            self.end_headers()

        def log_message(self, fmt, *args):  # quieter default logging
            pass

    return Handler


PAGE_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Image review</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; background: #111; color: #eee; }
  #word-bar { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; padding: 1rem; background: #222; border-radius: 8px; }
  #word-bar h2 { margin: 0; }
  #word-bar .gloss { color: #aaa; }
  #rubric-bar { margin-bottom: 1rem; padding: 0.75rem 1rem; background: #1c2733; border-left: 3px solid #4a9; border-radius: 4px; font-size: 0.85rem; color: #cde; }
  #rubric-bar b { color: #fff; }
  button { font-size: 1rem; padding: 0.5rem 1rem; cursor: pointer; border: none; border-radius: 6px; background: #444; color: #eee; }
  button:hover { background: #555; }
  button:disabled { opacity: 0.4; cursor: default; }
  #reject-btn { background: #644; }
  #accept-btn { background: #274; }
  #progress { margin-left: auto; color: #aaa; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .thumb { cursor: pointer; border: 3px solid transparent; border-radius: 6px; overflow: hidden; background: #222; aspect-ratio: 1; position: relative; }
  .thumb:hover { border-color: #4a9; }
  .thumb.selected { border-color: #4a9; box-shadow: 0 0 0 2px #4a9 inset; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .prompt { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); font-size: 0.7rem; padding: 4px; max-height: 40%; overflow: hidden; }
  .thumb .check { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,0.5); border: 2px solid #eee; display: none; align-items: center; justify-content: center; color: #fff; font-size: 0.9rem; }
  .thumb.selected .check { display: flex; background: #4a9; border-color: #4a9; }
  #done { font-size: 1.3rem; padding: 2rem; text-align: center; }
  #accept-bar { display: flex; justify-content: flex-end; margin-bottom: 0.75rem; }
  #existing-section { display: none; margin-bottom: 1rem; padding: 0.75rem 1rem; background: #1a2a1f; border-left: 3px solid #4a9; border-radius: 4px; }
  #existing-section .label { font-size: 0.85rem; color: #9dc; margin-bottom: 0.5rem; }
  #existing-strip { display: flex; flex-wrap: wrap; gap: 10px; }
  .existing-thumb { position: relative; width: 72px; height: 72px; border-radius: 6px; overflow: hidden; background: #222; }
  .existing-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .existing-thumb .variant-label { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); font-size: 0.65rem; text-align: center; padding: 1px 0; }
  .existing-thumb .delete-btn { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; padding: 0; border-radius: 50%; background: #a33; font-size: 0.7rem; line-height: 1; }
</style>
</head>
<body>
  <div id="word-bar">
    <div>
      <h2 id="word-id">...</h2>
      <div class="gloss" id="word-gloss"></div>
    </div>
    <button id="prev-btn">&larr; Prev</button>
    <button id="skip-btn">Skip</button>
    <button id="reject-btn">Reject all / regenerate</button>
    <div id="progress"></div>
  </div>
  <div id="rubric-bar"><b id="style-label"></b> - judge these against this style's own bar, not a generic "looks nice": <span id="rubric-text"></span></div>
  <div id="existing-section">
    <div class="label">Already accepted for this word/style - accepting candidates below adds MORE images, it never replaces these. Delete one here if it's no longer good.</div>
    <div id="existing-strip"></div>
  </div>
  <div id="accept-bar">
    <button id="accept-btn" disabled>Accept selected (0)</button>
  </div>
  <div id="grid"></div>
  <div id="done" style="display:none">Queue empty. Run generate.py for more words, then re-run this review.</div>

<script>
async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function refresh() {
  render(await fetchJson('/api/state'));
}

// Selection is a client-side set of candidate filenames, reset every time
// a new word's state renders (state.wordId changes) so stale selections
// from the previous word can never leak into an accept call.
let selected = new Set();
let selectedForWordId = null;

function updateAcceptButton() {
  const btn = document.getElementById('accept-btn');
  btn.textContent = 'Accept selected (' + selected.size + ')';
  btn.disabled = selected.size === 0;
}

function render(state) {
  if (!state.wordId) {
    document.getElementById('word-bar').style.display = 'none';
    document.getElementById('rubric-bar').style.display = 'none';
    document.getElementById('existing-section').style.display = 'none';
    document.getElementById('accept-bar').style.display = 'none';
    document.getElementById('grid').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    return;
  }
  if (state.wordId !== selectedForWordId) {
    selected = new Set();
    selectedForWordId = state.wordId;
  }
  const m = state.manifest;
  document.getElementById('word-id').textContent = state.wordId + ' - ' + (m.display_text || '');
  document.getElementById('word-gloss').textContent = m.definition || '(no definition)';
  document.getElementById('progress').textContent = (state.index + 1) + ' / ' + state.queueLength;
  document.getElementById('style-label').textContent = state.styleLabel;
  document.getElementById('rubric-text').textContent = state.reviewRubric;

  const existingSection = document.getElementById('existing-section');
  const existingStrip = document.getElementById('existing-strip');
  existingStrip.innerHTML = '';
  if (state.existingImages && state.existingImages.length > 0) {
    existingSection.style.display = 'block';
    state.existingImages.forEach((img) => {
      const div = document.createElement('div');
      div.className = 'existing-thumb';
      const el = document.createElement('img');
      el.src = '/existing-image/' + img.imageId;
      div.appendChild(el);
      const label = document.createElement('div');
      label.className = 'variant-label';
      label.textContent = '#' + img.variantNumber;
      div.appendChild(label);
      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.textContent = '\\u00d7';
      del.title = 'Delete this accepted image';
      del.onclick = async () => {
        const ok = confirm('Permanently delete accepted image #' + img.variantNumber + ' for "' + state.wordId + '"? This cannot be undone.');
        if (!ok) return;
        render(await fetchJson('/api/delete-existing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageId: img.imageId }),
        }));
      };
      div.appendChild(del);
      existingStrip.appendChild(div);
    });
  } else {
    existingSection.style.display = 'none';
  }

  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  document.getElementById('accept-bar').style.display = 'flex';
  document.getElementById('grid').style.display = 'grid';
  state.variants.forEach((filename, i) => {
    const div = document.createElement('div');
    div.className = 'thumb' + (selected.has(filename) ? ' selected' : '');
    const img = document.createElement('img');
    img.src = '/candidate-image/' + encodeURIComponent(filename) + '?_=' + state.wordId;
    div.appendChild(img);
    const check = document.createElement('div');
    check.className = 'check';
    check.textContent = '\\u2713';
    div.appendChild(check);
    const promptDiv = document.createElement('div');
    promptDiv.className = 'prompt';
    promptDiv.textContent = (m.prompts && m.prompts[i]) || '';
    div.appendChild(promptDiv);
    div.onclick = () => {
      // Toggle selection only - accepting is a separate explicit action
      // (the "Accept selected" button) so a reviewer can pick several
      // good candidates from one batch before anything is written.
      if (selected.has(filename)) {
        selected.delete(filename);
        div.classList.remove('selected');
      } else {
        selected.add(filename);
        div.classList.add('selected');
      }
      updateAcceptButton();
    };
    grid.appendChild(div);
  });
  updateAcceptButton();
}

document.getElementById('accept-btn').onclick = async () => {
  if (selected.size === 0) return;
  const variants = [...selected];
  const result = await fetchJson('/api/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variants }),
  });
  if (result.error) {
    alert('Not saved: ' + result.error);
    render(await fetchJson('/api/state'));
    return;
  }
  render(result);
};
document.getElementById('skip-btn').onclick = async () => render(await fetchJson('/api/skip', { method: 'POST' }));
document.getElementById('prev-btn').onclick = async () => render(await fetchJson('/api/prev', { method: 'POST' }));
document.getElementById('reject-btn').onclick = async () => render(await fetchJson('/api/reject', { method: 'POST' }));

refresh();
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--art-style", default=config.DEFAULT_ART_STYLE,
        help=f"one of: {', '.join(sorted(styles.STYLES))} (see styles.py to add more)",
    )
    parser.add_argument("--port", type=int, default=4322)
    args = parser.parse_args()

    art_style_dir = CANDIDATES_DIR / args.art_style
    queue = list_queue(art_style_dir)
    if not queue:
        print(f'No finished candidate batches under candidates/{args.art_style}/ - run generate.py first.')
        return
    print(f"{len(queue)} word(s) awaiting review.")

    conn = db.connect()
    handler = make_handler(args.art_style, art_style_dir, conn)
    # A connection that goes idle mid-request (a client that vanishes
    # without a clean close - browsers and curl can both do this) gets cut
    # loose after 30s instead of tying up its thread indefinitely - see
    # module docstring.
    handler.timeout = 30
    # Loopback only - see module docstring on why this must never listen on
    # every interface (Handler.do_POST /api/accept writes to the database
    # and do_GET serves files with no auth). ThreadingHTTPServer, not plain
    # HTTPServer - see module docstring on why a single-threaded server
    # here is exactly the kind of single-point-of-hang this tool keeps
    # running into.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Review UI running at http://localhost:{args.port}/")
    try:
        server.serve_forever()
    finally:
        # Best-effort - call_db may have already replaced/closed this
        # exact connection object during a reconnect (see make_handler),
        # in which case closing it again here is a harmless no-op, not
        # something worth crashing shutdown over.
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
