"""Bounded public Instagram lookup for the hackathon."""
import logging
import os
import time
from decimal import Decimal, InvalidOperation
from threading import Lock

import httpx

from instagram import IMPORT_HELP, preview_image
from story_data import post_permalink

ACTOR_URL = "https://api.apify.com/v2/actors/gatherworks~instagram-profile-scraper/run-sync-get-dataset-items"
CACHE_TTL = 300
logger = logging.getLogger(__name__)
_cache = {}
_lock = Lock()


def _lookup(username, token):
    charge_limit = os.getenv("SHOPSHOP_APIFY_MAX_CHARGE_USD", "0.10")
    try:
        post_limit = int(os.getenv("SHOPSHOP_APIFY_POST_LIMIT", "30"))
        charge = Decimal(charge_limit)
        if not 1 <= post_limit <= 2000 or not charge.is_finite() or charge <= 0:
            raise ValueError("Instagram scan limits out of range")
    except (InvalidOperation, ValueError):
        logger.error("Invalid SHOPSHOP_APIFY_POST_LIMIT or SHOPSHOP_APIFY_MAX_CHARGE_USD")
        return {"status": "instagram_unavailable", "reason": "invalid_scan_config",
                "message": "ค่าจำนวนโพสต์หรืองบ Apify บนเซิร์ฟเวอร์ไม่ถูกต้อง " + IMPORT_HELP}

    # The Actor returns one account row in addition to the requested posts.
    row_limit = post_limit + 1
    try:
        response = httpx.post(
            ACTOR_URL,
            headers={"Authorization": f"Bearer {token}"},
            params={"timeout": 25, "maxTotalChargeUsd": charge_limit, "limit": row_limit},
            json={"usernames": [username], "includePosts": True, "maxPostsPerAccount": post_limit},
            timeout=30,
        )
        rows = response.raise_for_status().json()
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        logger.warning("Apify Instagram lookup returned HTTP %s", code)
        if code in {401, 403}:
            return {"status": "instagram_unavailable", "reason": "apify_access_denied",
                    "message": "Apify ปฏิเสธการเข้าถึง ตรวจ APIFY_TOKEN และสิทธิ์ของบัญชี"}
        if code == 402:
            return {"status": "instagram_unavailable", "reason": "apify_budget_exhausted",
                    "message": "Apify แจ้งปัญหาด้านเครดิตหรือวงเงิน ตรวจบัญชี Apify"}
        return {"status": "instagram_unavailable", "reason": f"apify_http_{code}",
                "message": f"Apify ดึงโพสต์ไม่สำเร็จ (HTTP {code}) " + IMPORT_HELP}
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
    rows = [row for row in rows[:row_limit] if isinstance(row, dict)]
    account = next((row for row in rows if row.get("rowType") == "account"
                    and str(row.get("handle", "")).lower() == username), None)
    if account and account.get("isPrivate") is True:
        return {"status": "need_posts", "reason": "private_profile",
                "message": "บัญชี Instagram นี้เป็นแบบส่วนตัว " + IMPORT_HELP}
    if not account:
        logger.info("Apify did not return a verified public account row")
        return {"status": "need_posts", "reason": "no_public_account_row",
                "message": "Apify ไม่ส่งข้อมูลโปรไฟล์สาธารณะกลับมา " + IMPORT_HELP}
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
        return {"status": "ready", "posts": posts[:post_limit]}
    return {"status": "need_posts", "reason": "no_captioned_posts",
            "message": "Apify พบโปรไฟล์ แต่ไม่มีโพสต์พร้อมแคปชันให้ใช้ " + IMPORT_HELP}


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
