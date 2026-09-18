# Talks to the same Postgres database as scripts/migrateStagedImages.mjs and
# scripts/labelImagesGrid.mjs. A word can hold any number of accepted
# images per art_style - accept_image always adds the next variant_number
# rather than overwriting an existing one, and exportGameContent.mjs /
# publishToR2.mjs both read every variant, not just one (see db/README.md
# and 0010_word_images.sql). blob_path embeds the variant number
# (images/{style}/{word_id}/{variant}.png) to match publishToR2.mjs's key
# scheme.
import os

import psycopg


def connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set.")
    # review.py holds one connection open for an entire interactive review
    # session, which can sit idle for arbitrarily long stretches (a human
    # looking at images, thinking) - long enough, in practice, for a cloud
    # Postgres connection to die silently over the network. Without
    # keepalives, the next query on a connection like that doesn't error,
    # it just hangs forever (and since review.py's server is single-
    # threaded, that hang blocks every other request too - the whole UI
    # freezes with no error message and no way to recover short of
    # restarting the process). TCP keepalives make the OS detect a dead
    # peer within ~20s worst case (idle 10s, then up to 2 probes 5s apart)
    # and surface it as a real error instead - see review.py's reconnect
    # wrapper for what happens with that error once raised.
    # autocommit=True matters beyond style: psycopg defaults to opening an
    # implicit transaction on the first statement and leaving it open
    # until an explicit commit/rollback. review.py's read-only calls
    # (list_images, get_image, words_needing_image, word_by_id) never committed,
    # so between clicks the connection sat "idle in transaction" - exactly
    # the kind of session a cloud Postgres (or a pooler in front of it) is
    # liable to kill outright, which is a plausible reason the connection
    # went stale in the first place, not just an innocent side effect.
    return psycopg.connect(
        database_url, connect_timeout=10, autocommit=True,
        keepalives=1, keepalives_idle=10, keepalives_interval=5, keepalives_count=2,
    )


def words_needing_image(conn, art_style: str, word_ids: list[str] | None = None):
    """golden_record rows with no word_images row for art_style yet -
    the same "still needs an image" query labelImagesGrid.mjs uses."""
    query = """
        select w.word_id, w.display_text, w.definition
        from golden_record w
        where not exists (
            select 1 from word_images wi
            where wi.word_id = w.word_id and wi.art_style = %s
        )
    """
    params: list = [art_style]
    if word_ids:
        query += " and w.word_id = any(%s)"
        params.append(word_ids)
    query += " order by w.word_id"
    with conn.cursor() as cur:
        cur.execute(query, params)
        columns = [c.name for c in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def word_by_id(conn, word_id: str):
    with conn.cursor() as cur:
        cur.execute(
            "select word_id, display_text, definition from golden_record where word_id = %s",
            (word_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        columns = [c.name for c in cur.description]
        return dict(zip(columns, row))


def list_images(conn, word_id: str, art_style: str) -> list[dict]:
    """Metadata (no bytes - see get_image for that) for every already-
    accepted image for this word+style, in variant order. What review.py
    shows so a reviewer can see what already exists (and delete a bad one)
    instead of a single yes/no "does one exist" check. accept_image is now
    purely additive (see below), so this can return more than one row."""
    with conn.cursor() as cur:
        cur.execute(
            "select image_id, variant_number from word_images "
            "where word_id = %s and art_style = %s order by variant_number",
            (word_id, art_style),
        )
        columns = [c.name for c in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def get_image(conn, image_id: str) -> bytes | None:
    """One accepted image's bytes by id - what review.py's per-image
    thumbnail route serves, rather than list_images' full metadata-only
    listing."""
    with conn.cursor() as cur:
        cur.execute("select image_data from word_images where image_id = %s", (image_id,))
        row = cur.fetchone()
        return bytes(row[0]) if row else None


def accept_image(conn, word_id: str, art_style: str, image_bytes: bytes) -> int:
    """Adds a new variant - never overwrites or deletes an existing one
    (contrast the old single-image behavior, which upserted variant 1 in
    place and silently destroyed whatever was there before). blob_path
    embeds the variant number so each accepted image gets its own logical
    path (see 0010_word_images.sql and publishToR2.mjs's key scheme).
    Computing next_variant here (rather than once in the caller) is safe
    to call repeatedly in a loop: each call commits before returning, so
    the next call's max() sees this one's insert."""
    with conn.cursor() as cur:
        cur.execute(
            "select coalesce(max(variant_number), 0) + 1 from word_images "
            "where word_id = %s and art_style = %s",
            (word_id, art_style),
        )
        variant_number = cur.fetchone()[0]
        blob_path = f"images/{art_style}/{word_id}/{variant_number}.png"
        cur.execute(
            """
            insert into word_images (word_id, art_style, variant_number, image_data, content_type, blob_path)
            values (%s, %s, %s, %s, 'image/png', %s)
            """,
            (word_id, art_style, variant_number, image_bytes, blob_path),
        )
    conn.commit()
    return variant_number


def delete_image(conn, image_id: str):
    """Retires one accepted image - the escape hatch for a reviewer who
    accepted a bad variant and wants it gone rather than accumulating
    forever (see review.py's per-existing-image delete button)."""
    with conn.cursor() as cur:
        cur.execute("delete from word_images where image_id = %s", (image_id,))
    conn.commit()
