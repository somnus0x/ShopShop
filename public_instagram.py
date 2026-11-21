"""Bounded public Instagram lookup for the hackathon."""
from hashlib import blake2s
import logging
import os
import re
import time
from decimal import Decimal, InvalidOperation
from threading import Lock

import httpx

from instagram import IMPORT_HELP, preview_image
from story_data import post_permalink

ACTOR_URL = "https://api.apify.com/v2/actors/apify~instagram-post-scraper/run-sync-get-dataset-items"
CACHE_TTL = 300
logger = logging.getLogger(__name__)
_cache = {}
_lock = Lock()
_trace_key = os.urandom(16)


def profile_log_id(username):
    return blake2s(username.encode(), key=_trace_key, digest_size=6).hexdigest() if username else "-"



def _lookup(username, token):
    charge_limit = os.getenv("SHOPSHOP_APIFY_MAX_CHARGE_USD", "0.10")
    try:
        post_limit = int(os.getenv("SHOPSHOP_APIFY_POST_LIMIT", "30"))
        run_timeout = int(os.getenv("SHOPSHOP_APIFY_TIMEOUT_SECONDS", "50"))
        charge = Decimal(charge_limit)
        if not 1 <= post_limit <= 2000 or not 10 <= run_timeout <= 120 or not charge.is_finite() or charge <= 0:
            raise ValueError("Instagram scan limits out of range")
    except (InvalidOperation, ValueError):
        logger.error("Invalid Apify scan limit, budget, or timeout setting")
        return {"status": "instagram_unavailable", "reason": "invalid_scan_config",
                "message": "ค่าจำนวนโพสต์หรืองบ Apify บนเซิร์ฟเวอร์ไม่ถูกต้อง " + IMPORT_HELP}

    started = time.monotonic()
    lookup = profile_log_id(username)
    logger.info("instagram.apify.start profile=%s requested=%d timeout_s=%d cap_usd=%s",
                lookup, post_limit, run_timeout, charge)
    try:
        response = httpx.post(
            ACTOR_URL,
            headers={"Authorization": f"Bearer {token}"},
            params={"timeout": run_timeout, "maxTotalChargeUsd": charge_limit, "limit": post_limit,
                    "fields": "ownerUsername,url,caption,displayUrl,images,isPrivate,error,errorDescription"},
            json={"username": [f"https://www.instagram.com/{username}/"],
                  "resultsLimit": post_limit, "skipPinnedPosts": True},
            timeout=httpx.Timeout(run_timeout + 5, connect=5),
        )
        rows = response.raise_for_status().json()
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        try:
            provider_error = exc.response.json().get("error", {})
            error_type = provider_error.get("type", "")
        except (ValueError, AttributeError):
            error_type = ""
        if not isinstance(error_type, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", error_type):
            error_type = ""
        logger.warning("Apify Instagram lookup returned HTTP %s (%s)", code, error_type or "unknown")
        if code in {401, 403}:
            return {"status": "instagram_unavailable", "reason": "apify_access_denied",
                    "message": "Apify ปฏิเสธการเข้าถึง ตรวจ APIFY_TOKEN และสิทธิ์ของบัญชี"}
        if code == 402:
            return {"status": "instagram_unavailable", "reason": "apify_budget_exhausted",
                    "message": "Apify แจ้งปัญหาด้านเครดิตหรือวงเงิน ตรวจบัญชี Apify"}
        reason = f"apify_http_{code}"
        if error_type:
            reason += f":{error_type}"
        return {"status": "instagram_unavailable", "reason": reason,
                "message": f"Apify ดึงโพสต์ไม่สำเร็จ ({reason}) " + IMPORT_HELP}
    except httpx.TimeoutException:
        logger.warning("Apify Instagram lookup timed out")
        return {"status": "instagram_unavailable", "reason": "apify_timeout",
                "message": "Apify ใช้เวลาดึงโพสต์เกินกำหนด " + IMPORT_HELP}
    except (httpx.HTTPError, ValueError):
        logger.warning("Apify Instagram lookup failed before a usable response")
        return {"status": "instagram_unavailable", "reason": "apify_response_failed",
                "message": "เชื่อมต่อ Apify หรืออ่านผลการดึงโพสต์ไม่สำเร็จ " + IMPORT_HELP}
    if not isinstance(rows, list):
        return {"status": "instagram_unavailable", "reason": "apify_unexpected_response",
                "message": "รูปแบบผลจาก Apify ไม่ตรงกับที่ ShopShop ใช้ " + IMPORT_HELP}
    posts = []
    seen = set()
    matching_posts = 0
    for row in rows[:post_limit]:
        if not isinstance(row, dict):
            continue
        if row.get("isPrivate") is True:
            return {"status": "need_posts", "reason": "private_profile",
                    "message": "บัญชี Instagram นี้เป็นแบบส่วนตัว " + IMPORT_HELP}
        if str(row.get("ownerUsername") or "").lower() != username:
            continue
        url = post_permalink(str(row.get("url") or ""), "Instagram")
        if not url or url in seen:
            continue
        seen.add(url)
        matching_posts += 1
        caption = row.get("caption")
        if not isinstance(caption, str) or not caption.strip():
            continue
        images = row.get("images")
        first_photo = images[0] if isinstance(images, list) and images else None
        image = preview_image({"media_url": row.get("displayUrl")}) or preview_image({"media_url": first_photo})
        posts.append({"caption": caption.strip()[:480], "source_url": url, "image_url": image})
    logger.info("instagram.apify.finish profile=%s elapsed_ms=%d rows=%d matching=%d captions=%d images=%d",
                lookup, (time.monotonic()-started)*1000, len(rows), matching_posts,
                len(posts), sum(bool(post["image_url"]) for post in posts))
    if posts:
        return {"status": "ready", "posts": posts}
    if matching_posts:
        return {"status": "need_posts", "reason": "no_captioned_posts",
                "message": "Apify พบโพสต์ แต่ไม่มีแคปชันให้ใช้ " + IMPORT_HELP}
    return {"status": "need_posts", "reason": "no_public_posts",
            "message": "Apify ไม่พบโพสต์สาธารณะจากโปรไฟล์นี้ " + IMPORT_HELP}


def public_posts(username, token, *, cached_only=False):
    # One worker serves the demo. This also prevents two overlapping calls for the
    # same uncached profile from charging twice.
    with _lock:
        now = time.monotonic()
        cached = _cache.get(username)
        if cached and cached[0] > now:
            logger.info("instagram.cache profile=%s result=hit", profile_log_id(username))
            return cached[1]
        logger.info("instagram.cache profile=%s result=miss cached_only=%s", profile_log_id(username), cached_only)
        if cached_only:
            return {"status": "need_posts", "reason": "instagram_cache_miss", "message": "เปิดโพสต์อีกครั้งก่อนเลือกของขวัญ " + IMPORT_HELP}
        if len(_cache) >= 64:
            del _cache[min(_cache, key=lambda key: _cache[key][0])]
        result = _lookup(username, token)
        _cache[username] = (time.monotonic() + CACHE_TTL, result)
        return result
