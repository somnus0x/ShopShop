"""Bridge the demo widget to the shopping Mac's authenticated buyer MCP."""
import hashlib
import hmac
import os
import re
import time
from urllib.parse import urlsplit
from uuid import UUID

import anyio
import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

PRODUCT_ID = "demo-supasonk"


def configured():
    credentials = ("SHOPSHOP_BUYER_URL", "SHOPSHOP_BUYER_TOKEN", "SHOPSHOP_INQUIRY_SECRET", "SHOPSHOP_BUYER_DEMO_CODE")
    return os.getenv("SHOPSHOP_ENABLE_MERCHANT_MCP") == "1" and all(os.getenv(name) for name in credentials)


def qr_origin():
    value = os.getenv("SHOPSHOP_QR_ORIGIN", "").rstrip("/")
    parts = urlsplit(value)
    return value if parts.scheme == "https" and parts.netloc and not parts.username and not (parts.path or parts.query or parts.fragment) else ""


def _signature(value):
    return hmac.new(os.environ["SHOPSHOP_INQUIRY_SECRET"].encode(), value.encode(), hashlib.sha256).hexdigest()


async def _call(name, arguments):
    url = os.environ["SHOPSHOP_BUYER_URL"]
    token = os.environ["SHOPSHOP_BUYER_TOKEN"]
    with anyio.fail_after(12):
        async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as client:
            async with streamable_http_client(url, http_client=client) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(name, arguments)
    if result.isError or not isinstance(result.structuredContent, dict):
        raise ValueError("No structured buyer result")
    return result.structuredContent


def _public_result(payload):
    inquiry = payload.get("inquiry")
    if not isinstance(inquiry, dict):
        raise ValueError("Missing inquiry")
    origin = qr_origin()
    replies = []
    for reply in (payload.get("replies") or inquiry.get("replies") or []):
        if not isinstance(reply, dict):
            continue
        image = reply.get("qr_image_url") or ""
        replies.append({"text": str(reply.get("text") or ""),
                        "qr_image_url": image if origin and isinstance(image, str) and image.startswith(origin + "/") else ""})
    return {"status": str(inquiry.get("status") or "queued"), "replies": replies}


async def submit(request_id, demo_code):
    if not configured():
        return {"status": "unavailable"}
    try:
        if not hmac.compare_digest(demo_code.encode(), os.environ["SHOPSHOP_BUYER_DEMO_CODE"].encode()):
            return {"status": "denied"}
        request_id = str(UUID(request_id))
        payload = await _call("submit_product_inquiry", {"request_id": request_id, "product_id": PRODUCT_ID})
        result = _public_result(payload)
        inquiry_id = str(payload["inquiry"]["id"])
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", inquiry_id):
            raise ValueError("Unexpected inquiry ID")
        value = f"{inquiry_id}.{int(time.time()) + 86400}"
        return {**result, "ticket": f"{value}.{_signature(value)}"}
    except Exception:
        return {"status": "unavailable"}


async def refresh(ticket):
    if not configured():
        return {"status": "unavailable"}
    try:
        inquiry_id, expiry, signature = ticket.split(".")
        if int(expiry) < time.time() or not hmac.compare_digest(signature, _signature(f"{inquiry_id}.{expiry}")):
            return {"status": "expired"}
        payload = await _call("get_product_inquiry", {"inquiry_id": inquiry_id})
        if str(payload["inquiry"]["id"]) != inquiry_id:
            raise ValueError("Mismatched inquiry")
        return _public_result(payload)
    except Exception:
        return {"status": "unavailable"}
