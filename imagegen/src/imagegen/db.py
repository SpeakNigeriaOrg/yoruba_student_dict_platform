# Talks to the same Postgres database as scripts/migrateStagedImages.mjs and
# scripts/labelImagesGrid.mjs, and follows their conventions on purpose:
# word_images.variant_number 1 is the only slot exportGameContent.mjs /
# publishToR2.mjs ever read (both hardcode variant_number = 1 - see
# db/README.md), so review.py always writes variant 1 and the blob_path
# convention those scripts publish to (images/{style}/{word_id}.png, no
# variant suffix - migrateStagedImages.mjs's own blob_path, with a "_1"
# suffix, is never actually read by anything downstream).
import os

import psycopg


def connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set.")
    return psycopg.connect(database_url)


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


def accept_image(conn, word_id: str, art_style: str, image_bytes: bytes):
    blob_path = f"images/{art_style}/{word_id}.png"
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into word_images (word_id, art_style, variant_number, image_data, content_type, blob_path)
            values (%s, %s, 1, %s, 'image/png', %s)
            on conflict (word_id, art_style, variant_number)
            do update set image_data = excluded.image_data, blob_path = excluded.blob_path
            """,
            (word_id, art_style, image_bytes, blob_path),
        )
    conn.commit()
