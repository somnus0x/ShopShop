"""Generate an illustrated turntable from a small allowlist of profile themes."""
import asyncio
import base64
import logging
import os
import json
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from tempfile import gettempdir
from threading import Lock, Thread
from time import monotonic, time
from uuid import uuid4
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("shopshop.avatar")
THEMES = {
    "race": "technical race-day layers", "gym": "after-work gym essentials",
    "travel": "one-bag travel with a daypack", "trip": "practical travel layers",
    "dogs": "casual park-walk style", "plaid": "a subtle plaid layer",
    "flowers": "muted botanical accents", "place": "understated everyday city style",
    "music": "contemporary musician offstage style with practical layers",
}
DAY_SECONDS = 86400
_jobs = {}
_job_keys = {}
_lock = Lock()


@contextmanager
def _storage():
    mounted = os.getenv("RAILWAY_VOLUME_MOUNT_PATH")
    default = Path(mounted or gettempdir()) / "shopshop-avatars"
    directory = Path(os.getenv("SHOPSHOP_AVATAR_DIR") or default)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with closing(sqlite3.connect(directory / "avatars.sqlite3", timeout=3)) as db, db:
        db.execute("""CREATE TABLE IF NOT EXISTS avatars (
            id TEXT PRIMARY KEY, profile TEXT NOT NULL, cues TEXT NOT NULL, look TEXT NOT NULL,
            reference TEXT NOT NULL, picture BLOB NOT NULL, completed REAL NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS avatars_profile ON avatars (profile, completed)")
        yield db


def _saved(columns, where, parameters):
    try:
        with _storage() as db:
            return db.execute(f"SELECT {columns} FROM avatars WHERE {where} ORDER BY completed DESC LIMIT 1",
                              parameters).fetchone()
    except (sqlite3.Error, OSError) as exc:
        logger.warning("avatar.storage.read type=%s", type(exc).__name__)
        return None


def _save(job_id, username, cues, look, reference, picture):
    try:
        with _storage() as db:
            db.execute("INSERT INTO avatars VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (job_id, username, json.dumps(cues), look, reference, picture, time()))
        return True
    except (sqlite3.Error, OSError) as exc:
        logger.warning("avatar.storage.write type=%s", type(exc).__name__)
        return False


def _ready(job_id, origin, reference):
    return {"status": "ready", "job_id": job_id, "reference": reference,
            "image_url": f"{origin}/widget-avatar/{job_id}.webp"}


def quota():
    try:
        return min(30, max(0, int(os.getenv("SHOPSHOP_AVATAR_DAILY_LIMIT", "3"))))
    except ValueError:
        return 0


def enabled(asset_origin):
    return bool(asset_origin and os.getenv("OPENAI_API_KEY") and quota())


def _profile_photo(username):
    token = os.getenv("APIFY_TOKEN")
    if not token:
        return None
    try:
        response = httpx.post(
            "https://api.apify.com/v2/actors/apify~instagram-profile-scraper/run-sync-get-dataset-items",
            headers={"Authorization": f"Bearer {token}"},
            params={"timeout": 15, "maxTotalChargeUsd": "0.03", "limit": 1,
                    "fields": "username,profilePicUrlHD,profilePicUrl,private,isPrivate"},
            json={"usernames": [username]}, timeout=18,
        ).raise_for_status()
        rows = response.json()
        row = rows[0] if isinstance(rows, list) and rows else {}
        if str(row.get("username", "")).casefold() != username or row.get("private") is True or row.get("isPrivate") is True:
            return None
        image_url = row.get("profilePicUrlHD") or row.get("profilePicUrl")
        if not isinstance(image_url, str):
            return None
        parts = urlsplit(image_url)
        if (parts.scheme != "https" or parts.username is not None or parts.port not in (None, 443)
                or not (parts.hostname or "").endswith((".cdninstagram.com", ".fbcdn.net"))):
            return None
        with httpx.stream("GET", image_url, timeout=6, follow_redirects=False) as image:
            image.raise_for_status()
            mime = image.headers.get("content-type", "").split(";")[0].lower()
            if mime not in {"image/jpeg", "image/png", "image/webp"}:
                return None
            payload = bytearray()
            started = monotonic()
            for chunk in image.iter_bytes(chunk_size=65536):
                payload.extend(chunk)
                if len(payload) > 4_000_000 or monotonic()-started > 8:
                    return None
        if payload:
            extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime]
            return (f"reference.{extension}", bytes(payload), mime)
    except (httpx.HTTPError, ValueError, AttributeError):
        logger.info("avatar.reference status=unavailable")
    return None


def _generate(job_id, key, username, cues, look):
    started = monotonic()
    try:
        photo = _profile_photo(username)
        style = ", ".join(THEMES[cue] for cue in cues) or THEMES["place"]
        prompt = (
            "Render a 3D-style game character turnaround sprite sheet, exactly four equally sized columns "
            "and two equally sized rows on a 1536 by 1024 canvas. Same fictional adult character, outfit, "
            "body scale, camera height, pose and smooth neutral backdrop in all eight panels. Each complete "
            "head-to-shoes silhouette is centered inside its own panel with even padding. Read left to right "
            "on the top row and then the bottom, turning clockwise from front by another 45 degrees in each "
            "panel. No grid lines, text, captions, borders, or extra figures. Thai contemporary streetwear "
            f"styling inspired by {style}. Modern stylized matte 3D rendering."
            + (" Use the reference photo for visible hair, face shape, and accessories. Keep the stylized "
               "likeness consistent in all views." if photo else
               f" Render an original adult character with {look} styling.")
        )
        payload = {"model": os.getenv("SHOPSHOP_AVATAR_MODEL", "gpt-image-2.5-flare"),
                   "prompt": prompt, "size": "1536x1024", "quality": "medium", "n": 1,
                   "output_format": "webp"}
        arguments = {"data": payload, "files": {"image[]": photo}} if photo else {"json": payload}
        endpoint = "edits" if photo else "generations"
        logger.info("avatar.reference status=%s", "profile_photo" if photo else "style_fallback")
        response = httpx.post(
            f"https://api.openai.com/v1/images/{endpoint}",
            headers={"Authorization": f"Bearer {key}"},
            timeout=httpx.Timeout(120, connect=8),
            **arguments,
        ).raise_for_status()
        picture = base64.b64decode(response.json()["data"][0]["b64_json"], validate=True)
        if not picture.startswith(b"RIFF") or picture[8:12] != b"WEBP" or len(picture) > 8_000_000:
            raise ValueError("Invalid WebP result")
        reference = "profile_photo" if photo else "style"
        saved = _save(job_id, username, cues, look, reference, picture)
        with _lock:
            _jobs[job_id].update(status="ready", picture=picture, reference=reference)
        logger.info("avatar.finish elapsed_ms=%d bytes=%d saved=%s", (monotonic()-started)*1000, len(picture), saved)
    except Exception as exc:
        code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else "-"
        with _lock:
            _jobs[job_id]["status"] = "failed"
        logger.warning("avatar.failed elapsed_ms=%d type=%s http_status=%s",
                       (monotonic()-started)*1000, type(exc).__name__, code)


def start(profile_key, username, cues, origin, look="neutral"):
    cues = tuple(sorted(set(cues)))
    job_key = (profile_key, cues, look)
    with _lock:
        now = monotonic()
        for expired in [key for key, job in _jobs.items() if job["expires"] <= now]:
            old = _jobs.pop(expired)
            _job_keys.pop(old["key"], None)
        prior = _job_keys.get(job_key)
        if prior:
            return _job_result(prior, origin)
        saved = _saved("id, reference", "profile = ? AND cues = ? AND look = ?", (username, json.dumps(cues), look))
        if saved:
            return _ready(saved[0], origin, saved[1])
        if not enabled(origin):
            return {"status": "unavailable"}
        if len(_jobs) >= quota():
            return {"status": "limit_reached"}
        if any(job["status"] == "pending" for job in _jobs.values()):
            return {"status": "busy"}
        job_id = uuid4().hex
        _jobs[job_id] = {"status": "pending", "expires": now + DAY_SECONDS, "key": job_key, "username": username}
        _job_keys[job_key] = job_id
        Thread(target=_generate, args=(job_id, os.environ["OPENAI_API_KEY"], username, cues, look), daemon=True).start()
        logger.info("avatar.start themes=%d", len(cues))
        return _job_result(job_id, origin)


def _job_result(job_id, origin):
    job = _jobs.get(job_id)
    if not job or job["expires"] <= monotonic():
        saved = _saved("reference", "id = ?", (job_id,))
        return _ready(job_id, origin, saved[0]) if saved else {"status": "expired"}
    result = {"status": job["status"], "job_id": job_id}
    if job["status"] == "pending":
        result["status_url"] = f"{origin}/widget-avatar-job?id={job_id}"
    elif job["status"] == "ready":
        return _ready(job_id, origin, job["reference"])
    return result


def status(job_id, origin):
    with _lock:
        return _job_result(job_id, origin)


async def wait(result, origin, timeout):
    deadline = monotonic() + timeout
    while result["status"] == "pending":
        remaining = deadline - monotonic()
        if remaining <= 0:
            break
        await asyncio.sleep(min(1, remaining))
        result = status(result["job_id"], origin)
    return result


def current(username, origin):
    with _lock:
        for job_id, job in reversed(_jobs.items()):
            if job["username"] == username:
                result = _job_result(job_id, origin)
                if result["status"] != "expired":
                    return result
    saved = _saved("id, reference", "profile = ?", (username,))
    return _ready(saved[0], origin, saved[1]) if saved else None


def artwork(job_id):
    with _lock:
        job = _jobs.get(job_id)
        if job and job.get("picture"):
            return job["picture"]
    saved = _saved("picture", "id = ?", (job_id,))
    return saved[0] if saved else None
