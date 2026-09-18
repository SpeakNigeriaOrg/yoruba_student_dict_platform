# Local review UI for candidates/ produced by generate.py - the videogen
# sibling of imagegen/review.py, same shape (ThreadingHTTPServer, stdlib
# only, loopback-only, multi-select accept), with two real differences
# forced by video's storage design (0028_word_videos.sql):
#   - accepting a candidate uploads its bytes to R2's staging prefix
#     (r2.upload_staging) BEFORE writing the word_videos metadata row -
#     there is no bytea column to insert into directly the way
#     imagegen.db.accept_image does. This means this tool needs R2
#     credentials (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/
#     R2_BUCKET_NAME), not just DATABASE_URL - a real new operational
#     requirement imagegen/review.py never had.
#   - "already accepted" thumbnails are shown by linking straight at the
#     public bucket domain (BASE_URL + blob_key), not proxied through this
#     server - the staging objects are already reachable there the same
#     unauthenticated way live images/audio are (see publishToR2.mjs's
#     header on that trust model), so there is no reason to add a local
#     proxy route just to re-serve bytes this server would otherwise have
#     to fetch from R2 itself first.
#
# Usage:
#   DATABASE_URL=postgres://... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
#   R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... \
#     python -m videogen.review [--video-style cartoon] [--port 4323]
import argparse
import http.server
import json
import shutil
import threading
from pathlib import Path
from urllib.parse import urlparse

import psycopg

from . import config, db, r2, styles

CANDIDATES_DIR = Path(__file__).resolve().parent.parent.parent / "candidates"
# Same public bucket the live game reads from (public/vocab/app.js's
# BASE_URL) - staging objects are reachable there the same as published
# ones, per this module's docstring above.
BASE_URL = "https://gamemedia.speaknigeria.org/"


def list_queue(video_style_dir: Path) -> list[str]:
    if not video_style_dir.exists():
        return []
    return sorted(
        p.name for p in video_style_dir.iterdir() if p.is_dir() and (p / "manifest.json").exists()
    )


def make_handler(video_style: str, video_style_dir: Path, conn, s3):
    style = styles.get(video_style)
    state = {"queue": list_queue(video_style_dir), "index": 0}
    conn_holder = {"conn": conn}
    state_lock = threading.Lock()

    def call_db(fn, *args, **kwargs):
        """Same reconnect-on-stale-connection wrapper as imagegen/review.py's
        call_db - see that module's docstring for why."""
        try:
            return fn(conn_holder["conn"], *args, **kwargs)
        except psycopg.Error as exc:
            print(f"  (DB error ({exc}) - reconnecting and retrying once)")
            try:
                conn_holder["conn"].close()
            except Exception:  # noqa: BLE001
                pass
            conn_holder["conn"] = db.connect()
            return fn(conn_holder["conn"], *args, **kwargs)

    def current_word_dir():
        if state["index"] >= len(state["queue"]):
            return None
        return video_style_dir / state["queue"][state["index"]]

    def current_state():
        word_dir = current_word_dir()
        word_id = state["queue"][state["index"]] if word_dir else None
        manifest = json.loads((word_dir / "manifest.json").read_text(encoding="utf-8")) if word_dir else None
        variants = sorted(p.name for p in word_dir.glob("v*.mp4")) if word_dir else []
        existing_videos = call_db(db.list_videos, word_id, video_style) if word_id else []
        return {
            "index": state["index"],
            "queueLength": len(state["queue"]),
            "wordId": word_id,
            "manifest": manifest,
            "variants": variants,
            "styleLabel": style.label,
            "reviewRubric": style.review_rubric,
            "existingVideos": [
                {"videoId": str(v["video_id"]), "variantNumber": v["variant_number"], "blobKey": v["blob_key"]}
                for v in existing_videos
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
            if path.startswith("/candidate-video/"):
                filename = path[len("/candidate-video/"):]
                word_dir = current_word_dir()
                # Only ever serve a file from the CURRENT word's own
                # directory, never an arbitrary path built from client input.
                if word_dir is None or filename not in {p.name for p in word_dir.glob("v*.mp4")}:
                    self.send_response(404)
                    self.end_headers()
                    return
                data = (word_dir / filename).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
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
                available = {p.name for p in word_dir.glob("v*.mp4")}
                if not all(v in available for v in variants):
                    self._send_json({"error": "no such variant"}, 400)
                    return
                word_id = state["queue"][state["index"]]
                manifest = json.loads((word_dir / "manifest.json").read_text(encoding="utf-8"))
                duration_ms = round(manifest["num_frames"] / manifest["fps"] * 1000)
                for variant in variants:
                    data = (word_dir / variant).read_bytes()
                    blob_key, sha256 = r2.upload_staging(s3, video_style, word_id, variant, data)
                    call_db(
                        db.accept_video, word_id, video_style, blob_key, sha256,
                        duration_ms, manifest["width"], manifest["height"], len(data),
                    )
                shutil.rmtree(word_dir)
                print(f"Accepted {len(variants)} video(s) for {word_id}: {', '.join(variants)}")
                state["index"] = min(state["index"] + 1, len(state["queue"]))
                self._send_json(current_state())
                return

            if path == "/api/delete-existing":
                video_id = payload.get("videoId")
                if not video_id:
                    self._send_json({"error": "videoId required"}, 400)
                    return
                blob_key = call_db(db.get_video_blob_key, video_id)
                if blob_key:
                    r2.delete_object(s3, blob_key)
                call_db(db.delete_video, video_id)
                print(f"Deleted accepted video {video_id}")
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


PAGE_HTML_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Video review</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; background: #111; color: #eee; }
  #word-bar { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; padding: 1rem; background: #222; border-radius: 8px; }
  #word-bar h2 { margin: 0; }
  #word-bar .gloss { color: #aaa; }
  button { font-size: 1rem; padding: 0.5rem 1rem; cursor: pointer; border: none; border-radius: 6px; background: #444; color: #eee; }
  button:hover { background: #555; }
  button:disabled { opacity: 0.4; cursor: default; }
  #reject-btn { background: #644; }
  #accept-btn { background: #274; }
  #progress { margin-left: auto; color: #aaa; }
  #rubric-bar { margin-bottom: 1rem; padding: 0.75rem 1rem; background: #1c2733; border-left: 3px solid #4a9; border-radius: 4px; font-size: 0.85rem; color: #cde; }
  #rubric-bar b { color: #fff; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .thumb { cursor: pointer; border: 3px solid transparent; border-radius: 6px; overflow: hidden; background: #222; aspect-ratio: 1; position: relative; }
  .thumb:hover { border-color: #4a9; }
  .thumb.selected { border-color: #4a9; box-shadow: 0 0 0 2px #4a9 inset; }
  .thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .prompt { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); font-size: 0.7rem; padding: 4px; max-height: 40%; overflow: hidden; }
  .thumb .check { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,0.5); border: 2px solid #eee; display: none; align-items: center; justify-content: center; color: #fff; font-size: 0.9rem; }
  .thumb.selected .check { display: flex; background: #4a9; border-color: #4a9; }
  #done { font-size: 1.3rem; padding: 2rem; text-align: center; }
  #accept-bar { display: flex; justify-content: flex-end; margin-bottom: 0.75rem; }
  #existing-section { display: none; margin-bottom: 1rem; padding: 0.75rem 1rem; background: #1a2a1f; border-left: 3px solid #4a9; border-radius: 4px; }
  #existing-section .label { font-size: 0.85rem; color: #9dc; margin-bottom: 0.5rem; }
  #existing-strip { display: flex; flex-wrap: wrap; gap: 10px; }
  .existing-thumb { position: relative; width: 96px; height: 96px; border-radius: 6px; overflow: hidden; background: #222; }
  .existing-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
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
    <div class="label">Already accepted for this word/style - accepting candidates below adds MORE videos, it never replaces these. Delete one here if it's no longer good.</div>
    <div id="existing-strip"></div>
  </div>
  <div id="accept-bar">
    <button id="accept-btn" disabled>Accept selected (0)</button>
  </div>
  <div id="grid"></div>
  <div id="done" style="display:none">Queue empty. Run generate.py for more words, then re-run this review.</div>

<script>
const BASE_URL = "__BASE_URL__";

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function refresh() {
  render(await fetchJson('/api/state'));
}

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
  if (state.existingVideos && state.existingVideos.length > 0) {
    existingSection.style.display = 'block';
    state.existingVideos.forEach((v) => {
      const div = document.createElement('div');
      div.className = 'existing-thumb';
      const el = document.createElement('video');
      el.src = BASE_URL + v.blobKey;
      el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true;
      div.appendChild(el);
      const label = document.createElement('div');
      label.className = 'variant-label';
      label.textContent = '#' + v.variantNumber;
      div.appendChild(label);
      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.textContent = '\\u00d7';
      del.title = 'Delete this accepted video';
      del.onclick = async () => {
        const ok = confirm('Permanently delete accepted video #' + v.variantNumber + ' for "' + state.wordId + '"? This cannot be undone.');
        if (!ok) return;
        render(await fetchJson('/api/delete-existing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: v.videoId }),
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
    const video = document.createElement('video');
    video.src = '/candidate-video/' + encodeURIComponent(filename) + '?_=' + state.wordId;
    video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
    div.appendChild(video);
    const check = document.createElement('div');
    check.className = 'check';
    check.textContent = '\\u2713';
    div.appendChild(check);
    const promptDiv = document.createElement('div');
    promptDiv.className = 'prompt';
    promptDiv.textContent = (m.prompts && m.prompts[i]) || '';
    div.appendChild(promptDiv);
    div.onclick = () => {
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

PAGE_HTML = PAGE_HTML_TEMPLATE.replace("__BASE_URL__", BASE_URL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--video-style", default=config.DEFAULT_VIDEO_STYLE,
        help=f"one of: {', '.join(sorted(styles.STYLES))} (see styles.py to add more)",
    )
    parser.add_argument("--port", type=int, default=4323)
    args = parser.parse_args()

    video_style_dir = CANDIDATES_DIR / args.video_style
    queue = list_queue(video_style_dir)
    if not queue:
        print(f'No finished candidate batches under candidates/{args.video_style}/ - run generate.py first.')
        return
    print(f"{len(queue)} word(s) awaiting review.")

    conn = db.connect()
    s3 = r2.client()
    handler = make_handler(args.video_style, video_style_dir, conn, s3)
    handler.timeout = 30
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Review UI running at http://localhost:{args.port}/")
    try:
        server.serve_forever()
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
