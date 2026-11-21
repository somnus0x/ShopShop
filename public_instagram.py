"""Bounded public Instagram lookup for the hackathon."""
import time
from threading import Lock

import httpx

from instagram import IMPORT_HELP, preview_image
from story_data import post_permalink

ACTOR_URL = "https://api.apify.com/v2/actors/gatherworks~instagram-profile-scraper/run-sync-get-dataset-items"
CACHE_TTL = 300
_cache = {}
_lock = Lock()


def _lookup(username, token):
    try:
        response = httpx.post(
            ACTOR_URL,
            headers={"Authorization": f"Bearer {token}"},
            params={"timeout": 25, "maxTotalChargeUsd": "0.03", "limit": 7},
            json={"usernames": [username], "includePosts": True, "maxPostsPerAccount": 6},
            timeout=30,
        )
        rows = response.raise_for_status().json()
    except (httpx.HTTPError, ValueError):
        return {"status": "instagram_unavailable", "message": "เปิดโพสต์จาก Instagram ไม่สำเร็จ " + IMPORT_HELP}
    if not isinstance(rows, list):
        rows = []
    rows = [row for row in rows[:7] if isinstance(row, dict)]
    account = next((row for row in rows if row.get("rowType") == "account"
                    and str(row.get("handle", "")).lower() == username), None)
    if not account or account.get("isPrivate") is not False:
        return {"status": "need_posts", "message": "ไม่พบโพสต์สาธารณะของโปรไฟล์นี้ " + IMPORT_HELP}
    posts = []
    for row in rows:
        if row.get("rowType") != "post" or str(row.get("accountHandle", "")).lower() != username:
            continue
        url = post_permalink(str(row.get("postUrl") or ""), "Instagram")
        caption = str(row.get("postCaption") or "").strip()[:480]
        if not (url and caption):
            continue
        photos = row.get("imageUrls") or row.get("images")
        first_photo = photos[0] if isinstance(photos, list) and photos else None
        image = row.get("thumbnailUrl") or row.get("displayUrl") or row.get("imageUrl") or first_photo
        posts.append({"caption": caption, "source_url": url, "image_url": preview_image({"media_url": image})})
    if posts:
        return {"status": "ready", "posts": posts[:6]}
    return {"status": "need_posts", "message": "ยังไม่พบแคปชันที่ใช้ได้ " + IMPORT_HELP}


def public_posts(username, token, *, cached_only=False):
    # One worker serves the demo. This also prevents two overlapping calls for the
    # same uncached profile from charging twice.
    with _lock:
        now = time.monotonic()
        cached = _cache.get(username)
        if cached and cached[0] > now:
            return cached[1]
        if cached_only:
            return {"status": "need_posts", "message": "เปิดโพสต์อีกครั้งก่อนเลือกของขวัญ " + IMPORT_HELP}
        if len(_cache) >= 64:
            del _cache[min(_cache, key=lambda key: _cache[key][0])]
        result = _lookup(username, token)
        _cache[username] = (time.monotonic() + CACHE_TTL, result)
        return result
