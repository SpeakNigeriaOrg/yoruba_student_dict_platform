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
#     advances.
#   - Reject all  -> deletes the candidates dir without writing to the
#     database. The word has no image again, so the next generate.py run
#     (which only looks at words still missing one) naturally re-queues it.
#   - Skip / Prev  -> move the review queue without touching anything on
#     disk or in the database.
import argparse
import http.server
import json
import shutil
from pathlib import Path
from urllib.parse import urlparse

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

    def current_word_dir():
        if state["index"] >= len(state["queue"]):
            return None
        return art_style_dir / state["queue"][state["index"]]

    def current_state():
        word_dir = current_word_dir()
        manifest = json.loads((word_dir / "manifest.json").read_text()) if word_dir else None
        variants = sorted(p.name for p in word_dir.glob("v*.png")) if word_dir else []
        return {
            "index": state["index"],
            "queueLength": len(state["queue"]),
            "wordId": state["queue"][state["index"]] if word_dir else None,
            "manifest": manifest,
            "variants": variants,
            "styleLabel": style.label,
            "reviewRubric": style.review_rubric,
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
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
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
                db.accept_image(conn, word_id, art_style, variant_path.read_bytes())
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
    div.onclick = async () => render(await fetchJson('/api/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: filename }),
    }));
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
    # Loopback only - see module docstring on why this must never listen on
    # every interface (Handler.do_POST /api/accept writes to the database
    # and do_GET serves files with no auth).
    server = http.server.HTTPServer(("127.0.0.1", args.port), handler)
    print(f"Review UI running at http://localhost:{args.port}/")
    try:
        server.serve_forever()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
