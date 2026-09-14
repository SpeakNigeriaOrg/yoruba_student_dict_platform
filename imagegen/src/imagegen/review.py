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
# images side by side.
#   - click a thumbnail  -> accept it: upserts into word_images (variant 1,
#     the only slot exportGameContent.mjs/publishToR2.mjs read - see
#     db.py), deletes the whole candidates/{art_style}/{word_id}/ dir, and
#     advances. IMPORTANT: candidates/ can and does contain words that
#     already have an accepted (possibly already-live/published) image -
#     generate.py's queue is normally "words missing one", but --words can
#     target anything, and a batch generated for one purpose sits in
#     candidates/ the same as any other until reviewed. Accepting a
#     candidate for such a word REPLACES that existing image - there is no
#     version history. This UI warns and requires explicit confirmation
#     before that specific action; it was originally a silent upsert with
#     no warning at all, which is exactly the kind of thing a reviewer
#     should be stopped and asked about, not have happen to them by
#     surprise.
#   - Reject all  -> deletes the candidates dir without writing to the
#     database. The word has no image again, so the next generate.py run
#     (which only looks at words still missing one) naturally re-queues it.
#     Never touches an existing accepted image - safe regardless.
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
        has_existing_image = word_id is not None and call_db(db.existing_image, word_id, art_style) is not None
        return {
            "index": state["index"],
            "queueLength": len(state["queue"]),
            "wordId": word_id,
            "manifest": manifest,
            "variants": variants,
            "styleLabel": style.label,
            "reviewRubric": style.review_rubric,
            "hasExistingImage": has_existing_image,
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
            if path == "/existing-image":
                # Only ever the CURRENT word's own existing DB row - same
                # posture as /candidate-image/, no client-supplied word_id.
                word_dir = current_word_dir()
                word_id = state["queue"][state["index"]] if word_dir else None
                data = call_db(db.existing_image, word_id, art_style) if word_id else None
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
                variant = payload.get("variant")
                variant_path = word_dir / variant if variant else None
                if not variant_path or not variant_path.exists():
                    self._send_json({"error": "no such variant"}, 400)
                    return
                word_id = state["queue"][state["index"]]
                # Re-check server-side, not just trust the client's last-seen
                # state - never silently replace an existing accepted image
                # without an explicit, informed confirmation for THIS request.
                if call_db(db.existing_image, word_id, art_style) is not None and not payload.get("confirmOverwrite"):
                    self._send_json(
                        {"error": "existing image present - resend with confirmOverwrite: true to replace it"}, 409,
                    )
                    return
                call_db(db.accept_image, word_id, art_style, variant_path.read_bytes())
                shutil.rmtree(word_dir)
                print(f"Accepted {variant} for {word_id}")
                state["index"] = min(state["index"] + 1, len(state["queue"]))
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
  #reject-btn { background: #644; }
  #progress { margin-left: auto; color: #aaa; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .thumb { cursor: pointer; border: 3px solid transparent; border-radius: 6px; overflow: hidden; background: #222; aspect-ratio: 1; position: relative; }
  .thumb:hover { border-color: #4a9; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .prompt { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); font-size: 0.7rem; padding: 4px; max-height: 40%; overflow: hidden; }
  #done { font-size: 1.3rem; padding: 2rem; text-align: center; }
  #existing-warning { display: none; margin-bottom: 1rem; padding: 0.75rem 1rem; background: #3a1f1f; border-left: 3px solid #d55; border-radius: 4px; font-size: 0.85rem; color: #fdd; align-items: center; gap: 12px; }
  #existing-warning img { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; border: 2px solid #d55; flex-shrink: 0; }
  #existing-warning b { color: #fff; }
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
  <div id="existing-warning">
    <img id="existing-thumb" alt="existing image">
    <div><b>This word already has an accepted image.</b> Clicking a candidate below will PERMANENTLY REPLACE it - there is no version history. You'll be asked to confirm.</div>
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

function render(state) {
  if (!state.wordId) {
    document.getElementById('word-bar').style.display = 'none';
    document.getElementById('rubric-bar').style.display = 'none';
    document.getElementById('existing-warning').style.display = 'none';
    document.getElementById('grid').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    return;
  }
  const m = state.manifest;
  document.getElementById('word-id').textContent = state.wordId + ' - ' + (m.display_text || '');
  document.getElementById('word-gloss').textContent = m.definition || '(no definition)';
  document.getElementById('progress').textContent = (state.index + 1) + ' / ' + state.queueLength;
  document.getElementById('style-label').textContent = state.styleLabel;
  document.getElementById('rubric-text').textContent = state.reviewRubric;

  const warning = document.getElementById('existing-warning');
  if (state.hasExistingImage) {
    document.getElementById('existing-thumb').src = '/existing-image?_=' + state.wordId;
    warning.style.display = 'flex';
  } else {
    warning.style.display = 'none';
  }

  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  state.variants.forEach((filename, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.src = '/candidate-image/' + encodeURIComponent(filename) + '?_=' + state.wordId;
    div.appendChild(img);
    const promptDiv = document.createElement('div');
    promptDiv.className = 'prompt';
    promptDiv.textContent = (m.prompts && m.prompts[i]) || '';
    div.appendChild(promptDiv);
    div.onclick = async () => {
      // A word already carrying an accepted (possibly already-live) image
      // gets an explicit, informed confirmation before that image is
      // permanently replaced - never a silent one-click overwrite.
      if (state.hasExistingImage) {
        const ok = confirm(
          'This word ("' + state.wordId + '") already has an accepted ' + state.styleLabel +
          ' image. Replace it with this candidate?\\n\\nThis cannot be undone - there is no version history.'
        );
        if (!ok) return;
      }
      const result = await fetchJson('/api/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: filename, confirmOverwrite: state.hasExistingImage }),
      });
      if (result.error) {
        // Server-side re-check refused it (e.g. a concurrent change) -
        // surface that rather than rendering a malformed state.
        alert('Not saved: ' + result.error);
        render(await fetchJson('/api/state'));
        return;
      }
      render(result);
    };
    grid.appendChild(div);
  });
}

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
