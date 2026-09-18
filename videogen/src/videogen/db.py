# The videogen sibling of imagegen/db.py, for word_videos
# (0028_word_videos.sql) rather than word_images. Talks to the same
# Postgres database. Unlike accept_image, accept_video takes a blob_key
# instead of raw bytes - the bytes were already uploaded to R2's staging
# prefix by the caller (see r2.upload_staging) before this module ever
# touches Postgres, since there is no bytea column for video to insert
# into in the first place.
import os

import psycopg

# word_by_id is generic (golden_record lookup, nothing image-specific) -
# reused rather than duplicated. See videogen/pyproject.toml's path
# dependency on imagegen.
from imagegen.db import word_by_id  # noqa: F401


def connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set.")
    # Same reconnect-on-stale-connection posture as imagegen/db.py's
    # connect() - review.py holds one connection open for an entire
    # interactive session that can sit idle for a long time.
    return psycopg.connect(
        database_url, connect_timeout=10, autocommit=True,
        keepalives=1, keepalives_idle=10, keepalives_interval=5, keepalives_count=2,
    )


def words_needing_video(conn, video_style: str, word_ids: list[str] | None = None):
    """golden_record rows with no word_videos row for video_style yet -
    the video equivalent of imagegen.db.words_needing_image."""
    query = """
        select w.word_id, w.display_text, w.definition
        from golden_record w
        where not exists (
            select 1 from word_videos wv
            where wv.word_id = w.word_id and wv.video_style = %s
        )
    """
    params: list = [video_style]
    if word_ids:
        query += " and w.word_id = any(%s)"
        params.append(word_ids)
    query += " order by w.word_id"
    with conn.cursor() as cur:
        cur.execute(query, params)
        columns = [c.name for c in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def list_videos(conn, word_id: str, video_style: str) -> list[dict]:
    """Metadata for every already-accepted video for this word+style, in
    variant order - what review.py shows so a reviewer can see what
    already exists (and delete a bad one), same shape as
    imagegen.db.list_images."""
    with conn.cursor() as cur:
        cur.execute(
            "select video_id, variant_number, blob_key from word_videos "
            "where word_id = %s and video_style = %s order by variant_number",
            (word_id, video_style),
        )
        columns = [c.name for c in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def accept_video(
    conn, word_id: str, video_style: str, blob_key: str, sha256: str,
    duration_ms: int, width: int, height: int, byte_length: int,
) -> int:
    """Adds a new variant - never overwrites an existing one, same
    additive posture as imagegen.db.accept_image. The clip's bytes must
    already be uploaded to blob_key (R2 staging) before this is called;
    this only ever writes metadata."""
    with conn.cursor() as cur:
        cur.execute(
            "select coalesce(max(variant_number), 0) + 1 from word_videos "
            "where word_id = %s and video_style = %s",
            (word_id, video_style),
        )
        variant_number = cur.fetchone()[0]
        cur.execute(
            """
            insert into word_videos
                (word_id, video_style, variant_number, content_type, duration_ms,
                 width, height, byte_length, blob_key, sha256)
            values (%s, %s, %s, 'video/mp4', %s, %s, %s, %s, %s, %s)
            """,
            (word_id, video_style, variant_number, duration_ms, width, height, byte_length, blob_key, sha256),
        )
    conn.commit()
    return variant_number


def get_video_blob_key(conn, video_id: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute("select blob_key from word_videos where video_id = %s", (video_id,))
        row = cur.fetchone()
        return row[0] if row else None


def delete_video(conn, video_id: str):
    """Removes the metadata row. Callers that also want the staged R2
    object gone (rather than left as an orphan for publishToR2.mjs's
    orphan report to eventually flag) should get_video_blob_key first and
    call r2.delete_object before this - see review.py's delete handler."""
    with conn.cursor() as cur:
        cur.execute("delete from word_videos where video_id = %s", (video_id,))
    conn.commit()
