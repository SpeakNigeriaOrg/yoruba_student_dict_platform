# Minimal R2 client for the staging upload step - the Python-side
# equivalent of scripts/publishToR2.mjs's S3Client setup, but scoped to
# exactly one thing: put a just-accepted candidate clip into the staging
# prefix so word_videos.blob_key has something real to point at (there is
# no Postgres bytea column for video - see 0028_word_videos.sql). Promoting
# a staged object to its public key at actual publish time is
# publishToR2.mjs's job, not this module's - this only ever writes under
# staging/.
import hashlib
import os

import boto3


def client():
    account_id = os.environ.get("R2_ACCOUNT_ID")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not (account_id and access_key and secret_key):
        raise SystemExit("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set.")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def bucket_name() -> str:
    bucket = os.environ.get("R2_BUCKET_NAME")
    if not bucket:
        raise SystemExit("R2_BUCKET_NAME is not set.")
    return bucket


def upload_staging(s3, video_style: str, word_id: str, filename: str, data: bytes) -> tuple[str, str]:
    """Uploads one candidate's bytes to the staging prefix and returns
    (blob_key, sha256). Staging keys are unique per accept (not per
    word+style+variant) so two different accepted clips for the same word
    never collide even before variant_number is known - the DB row is what
    assigns the real variant_number, once, atomically (see db.accept_video)."""
    sha256 = hashlib.sha256(data).hexdigest()
    blob_key = f"staging/videos/{video_style}/{word_id}/{sha256[:16]}.mp4"
    s3.put_object(Bucket=bucket_name(), Key=blob_key, Body=data, ContentType="video/mp4")
    return blob_key, sha256


def delete_object(s3, blob_key: str):
    s3.delete_object(Bucket=bucket_name(), Key=blob_key)
