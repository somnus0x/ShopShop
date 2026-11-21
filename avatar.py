"""Generate an illustrated turntable from a small allowlist of profile themes."""
import base64
import logging
import os
from threading import Lock, Thread
from time import monotonic
from uuid import uuid4

import httpx

logger = logging.getLogger("shopshop.avatar")
THEMES = {
    "race": "technical race-day layers", "gym": "after-work gym essentials",
    "travel": "one-bag travel with a daypack", "trip": "practical travel layers",
    "dogs": "casual park-walk style", "plaid": "a subtle plaid layer",
    "flowers": "muted botanical accents", "place": "understated everyday city style",
}
DAY_SECONDS = 86400
_jobs = {}
_job_keys = {}
_lock = Lock()


def quota():
    try:
        return min(30, max(0, int(os.getenv("SHOPSHOP_AVATAR_DAILY_LIMIT", "3"))))
    except ValueError:
        return 0


def enabled(asset_origin):
    return bool(asset_origin and os.getenv("OPENAI_API_KEY") and quota())


def _generate(job_id, key, cues):
    started = monotonic()
    try:
        style = ", ".join(THEMES[cue] for cue in cues) or THEMES["place"]
        prompt = (
            "Render a 3D-style game character turnaround sprite sheet, exactly four equally sized columns "
            "and two equally sized rows on a 1536 by 1024 canvas. Same fictional adult character, outfit, "
            "body scale, camera height, pose and smooth neutral backdrop in all eight panels. Each complete "
            "head-to-shoes silhouette is centered inside its own panel with even padding. Read left to right "
            "on the top row and then the bottom, turning clockwise from front by another 45 degrees in each "
            "panel. No grid lines, text, captions, borders, or extra figures. Thai contemporary streetwear "
            f"styling inspired by {style}. Original fictional likeness, modern stylized matte 3D rendering."
        )
        response = httpx.post(
            "https://api.openai.com/v1/images/generations",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": os.getenv("SHOPSHOP_AVATAR_MODEL", "gpt-image-2.5-flare"),
                  "prompt": prompt, "size": "1536x1024", "quality": "medium", "n": 1,
                  "output_format": "webp"},
            timeout=httpx.Timeout(120, connect=8),
        ).raise_for_status()
        picture = base64.b64decode(response.json()["data"][0]["b64_json"], validate=True)
        if not picture.startswith(b"RIFF") or picture[8:12] != b"WEBP" or len(picture) > 8_000_000:
            raise ValueError("Invalid WebP result")
        with _lock:
            _jobs[job_id].update(status="ready", picture=picture)
        logger.info("avatar.finish elapsed_ms=%d bytes=%d", (monotonic()-started)*1000, len(picture))
    except Exception as exc:
        code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else "-"
        with _lock:
            _jobs[job_id]["status"] = "failed"
        logger.warning("avatar.failed elapsed_ms=%d type=%s http_status=%s",
                       (monotonic()-started)*1000, type(exc).__name__, code)


def start(profile_key, cues, origin):
    if not enabled(origin):
        return {"status": "unavailable"}
    cues = tuple(sorted(set(cues)))
    job_key = (profile_key, cues)
    with _lock:
        now = monotonic()
        for expired in [key for key, job in _jobs.items() if job["expires"] <= now]:
            old = _jobs.pop(expired)
            _job_keys.pop(old["key"], None)
        prior = _job_keys.get(job_key)
        if prior:
            return _job_result(prior, origin)
        if len(_jobs) >= quota():
            return {"status": "limit_reached"}
        if any(job["status"] == "pending" for job in _jobs.values()):
            return {"status": "busy"}
        job_id = uuid4().hex
        _jobs[job_id] = {"status": "pending", "expires": now + DAY_SECONDS, "key": job_key}
        _job_keys[job_key] = job_id
        Thread(target=_generate, args=(job_id, os.environ["OPENAI_API_KEY"], cues), daemon=True).start()
        logger.info("avatar.start themes=%d", len(cues))
        return _job_result(job_id, origin)


def _job_result(job_id, origin):
    job = _jobs.get(job_id)
    if not job or job["expires"] <= monotonic():
        return {"status": "expired"}
    result = {"status": job["status"], "job_id": job_id}
    if job["status"] == "ready":
        result["image_url"] = f"{origin}/widget-avatar/{job_id}.webp"
    return result


def status(job_id, origin):
    with _lock:
        return _job_result(job_id, origin)


def artwork(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return job.get("picture") if job and job["expires"] > monotonic() else None
