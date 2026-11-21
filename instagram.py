"""Read recent evidence from the demo workspace's authorized Instagram account."""
import os
from urllib.parse import urlsplit

import httpx

from story_data import instagram_handle, post_permalink

GRAPH_URL = "https://graph.instagram.com/v27.0"
IMPORT_HELP = "ส่งแคปชันหรือภาพหน้าจอของโพสต์ในแชตเพื่อให้ shopshop ใช้เป็นหลักฐานได้"


def preview_image(media):
    if media.get("media_type") == "CAROUSEL_ALBUM":
        return next((image for item in (media.get("children") or {}).get("data", [])
                     if (image := preview_image(item))), None)
    url = media.get("thumbnail_url" if media.get("media_type") == "VIDEO" else "media_url")
    if not isinstance(url, str):
        return None
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme == "https" and parts.username is None and host.endswith((".cdninstagram.com", ".fbcdn.net")):
        return url
    return None


def instagram_posts(profile_url, *, cached_only=False):
    username = instagram_handle(profile_url)
    if not username:
        return {"status": "need_instagram_profile", "message": "ใช้ลิงก์หน้าโปรไฟล์ Instagram " + IMPORT_HELP}
    apify_token = os.getenv("APIFY_TOKEN")
    if apify_token:
        from public_instagram import public_posts
        return public_posts(username, apify_token, cached_only=cached_only)
    account_id = os.getenv("SHOPSHOP_IG_ACCOUNT_ID", "")
    token = os.getenv("SHOPSHOP_IG_ACCESS_TOKEN", "")
    if not token or not account_id.isascii() or not account_id.isdecimal():
        return {"status": "need_posts", "message": "เวิร์กสเปซนี้ยังไม่ได้เชื่อมบัญชี Instagram Professional " + IMPORT_HELP}
    fields = "caption,permalink,media_type,media_url,thumbnail_url,children{media_type,media_url,thumbnail_url}"
    try:
        with httpx.Client(base_url=GRAPH_URL, headers={"Authorization": f"Bearer {token}"}, timeout=5.0) as client:
            account = client.get(f"/{account_id}", params={"fields": "username"}).raise_for_status().json()
            if account.get("username", "").lower() != username:
                return {"status": "need_posts", "message": "โปรไฟล์นี้ยังไม่ได้เชื่อมกับ shopshop " + IMPORT_HELP}
            feed = client.get(f"/{account_id}/media", params={"fields": fields, "limit": 6}).raise_for_status().json()
    except (httpx.HTTPError, ValueError):
        # The provider response can contain signed URLs or credential details.
        return {"status": "instagram_unavailable", "message": "เปิดโพสต์จาก Instagram ไม่สำเร็จในตอนนี้ " + IMPORT_HELP}

    posts = []
    for item in feed.get("data", [])[:6]:
        permalink = post_permalink(item.get("permalink"), "Instagram")
        caption = (item.get("caption") or "").strip()[:480]
        if caption and permalink:
            posts.append({"caption": caption, "source_url": permalink, "image_url": preview_image(item)})
    if not posts:
        return {"status": "need_posts", "message": "ยังไม่พบโพสต์ที่มีแคปชันให้ใช้ " + IMPORT_HELP}
    return {"status": "ready", "posts": posts}
