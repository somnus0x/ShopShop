"""Bridge ShopShop to the buyer REST API or the existing buyer MCP."""
from contextlib import asynccontextmanager
import hashlib
import hmac
import os
import re
import time
from urllib.parse import quote, urljoin, urlsplit
from uuid import UUID

import anyio
import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

PRODUCT_ID = "demo-supasonk"
_process_signing_key = os.urandom(32)


def configured():
    if rest_origin():
        return all(os.getenv(name) for name in ("SHOPSHOP_INQUIRY_SECRET", "SHOPSHOP_BUYER_DEMO_CODE"))
    credentials = ("SHOPSHOP_BUYER_URL", "SHOPSHOP_BUYER_TOKEN", "SHOPSHOP_INQUIRY_SECRET", "SHOPSHOP_BUYER_DEMO_CODE")
    return os.getenv("SHOPSHOP_ENABLE_MERCHANT_MCP") == "1" and all(os.getenv(name) for name in credentials)


def rest_origin():
    value = os.getenv("SHOPSHOP_BUYER_REST_URL", "").rstrip("/")
    parts = urlsplit(value)
    return value if parts.scheme == "https" and parts.hostname and not parts.username and not (parts.path or parts.query or parts.fragment) else ""


def qr_origin():
    value = os.getenv("SHOPSHOP_QR_ORIGIN", "").rstrip("/")
    parts = urlsplit(value)
    return value if parts.scheme == "https" and parts.netloc and not parts.username and not (parts.path or parts.query or parts.fragment) else rest_origin()


def _signature(value):
    secret = os.getenv("SHOPSHOP_INQUIRY_SECRET")
    return hmac.new(secret.encode() if secret else _process_signing_key, value.encode(), hashlib.sha256).hexdigest()


def widget_grant(request_id):
    value = f"submit.{request_id}.{int(time.time()) + 3600}"
    return f"{value}.{_signature(value)}"


async def submit_widget(request_id, grant):
    if not rest_origin():
        return {"status": "unavailable"}
    try:
        request_id = str(UUID(request_id))
        action, bound_id, expiry, signature = grant.split(".")
        if action != "submit" or bound_id != request_id or int(expiry) < time.time():
            return {"status": "expired"}
        if not hmac.compare_digest(signature, _signature(f"submit.{bound_id}.{expiry}")):
            return {"status": "denied"}
    except (ValueError, TypeError, AttributeError):
        return {"status": "denied"}
    return await _submit(request_id)


@asynccontextmanager
async def _session():
    url = os.environ["SHOPSHOP_BUYER_URL"]
    token = os.environ["SHOPSHOP_BUYER_TOKEN"]
    with anyio.fail_after(12):
        async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as client:
            async with streamable_http_client(url, http_client=client) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    yield session


async def check_connection():
    if rest_origin():
        try:
            catalog = await _rest("GET", "/api/products", params={"limit": 1})
            return {"status": "ready", "catalog": "available" if isinstance(catalog.get("products"), list) else "absent",
                    "transport": "rest", "inquiries": "demo_available"}
        except (httpx.HTTPError, ValueError):
            return {"status": "buyer_unreachable", "transport": "rest"}
    if not configured():
        return {"status": "not_configured"}
    try:
        async with _session() as session:
            advertised = {tool.name for tool in (await session.list_tools()).tools}
        required = {"submit_product_inquiry", "get_product_inquiry"}
        return {"status": "ready" if required <= advertised else "missing_buyer_tools",
                "catalog": "available" if {"list_products", "get_product"} <= advertised else "absent"}
    except Exception:
        return {"status": "buyer_unreachable"}


async def _rest(method, path, **kwargs):
    async with httpx.AsyncClient(base_url=rest_origin(), timeout=8) as client:
        response = await client.request(method, path, **kwargs)
    data = response.raise_for_status().json()
    if not isinstance(data, dict):
        raise ValueError("Expected a buyer REST object")
    return data


def _rest_product(product):
    if not isinstance(product, dict):
        return product
    path = product.get("image_url")
    return {**product, "brand": product.get("merchant"), "price_thb": (
        product.get("price") if product.get("currency") == "THB" else None
    ), "image_url": urljoin(rest_origin(), path) if isinstance(path, str) and path.startswith("/api/products/") else None}


async def read_catalog(tool_name, arguments, *, limit=15):
    if rest_origin():
        try:
            if tool_name == "list_products":
                data = await _rest("GET", "/api/products", params={**arguments, "limit": limit})
                if isinstance(data.get("products"), list):
                    data["products"] = [_rest_product(product) for product in data["products"]]
                return data
            product_id = quote(arguments["product_id"], safe="")
            data = await _rest("GET", f"/api/products/{product_id}")
            return {**data, "product": _rest_product(data.get("product"))}
        except (httpx.HTTPError, ValueError):
            return None
    if not configured():
        return None
    try:
        async with _session() as session:
            advertised = {tool.name for tool in (await session.list_tools()).tools}
            if not {"list_products", "get_product"} <= advertised:
                return None
            result = await session.call_tool(tool_name, arguments)
        if not result.isError and isinstance(result.structuredContent, dict):
            return result.structuredContent
    except Exception:
        return None
    return None


async def _call(name, arguments):
    async with _session() as session:
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
        if rest_origin() and isinstance(image, str) and image.startswith("/") and not image.startswith("//"):
            image = urljoin(rest_origin(), image)
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
    except (ValueError, TypeError, AttributeError):
        return {"status": "denied"}
    return await _submit(request_id)


async def _submit(request_id):
    try:
        arguments = {"request_id": request_id, "product_id": PRODUCT_ID}
        payload = await _rest("POST", "/api/inquiries", json=arguments) if rest_origin() else await _call("submit_product_inquiry", arguments)
        result = _public_result(payload)
        inquiry_id = str(payload["inquiry"]["id"])
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", inquiry_id):
            raise ValueError("Unexpected inquiry ID")
        value = f"{inquiry_id}.{int(time.time()) + 86400}"
        return {**result, "ticket": f"{value}.{_signature(value)}",
                "created": payload.get("created", True)}
    except Exception:
        return {"status": "unavailable"}


async def refresh(ticket):
    if not (rest_origin() or configured()):
        return {"status": "unavailable"}
    try:
        inquiry_id, expiry, signature = ticket.split(".")
        if (not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", inquiry_id)
                or int(expiry) < time.time() or not hmac.compare_digest(signature, _signature(f"{inquiry_id}.{expiry}"))):
            return {"status": "expired"}
        payload = await _rest("GET", f"/api/inquiries/{inquiry_id}") if rest_origin() else await _call("get_product_inquiry", {"inquiry_id": inquiry_id})
        if str(payload["inquiry"]["id"]) != inquiry_id:
            raise ValueError("Mismatched inquiry")
        return _public_result(payload)
    except Exception:
        return {"status": "unavailable"}
