# ShopShop REST API handoff

Connect your frontend backend to browse products, queue the demo inquiry, and poll for replies.

# Connect

**Base URL:** `https://rochester-tear-ensemble-float.trycloudflare.com`

**Auth:** None for the hackathon buyer REST API. Anyone with the URL can browse and submit inquiries; anyone with an inquiry ID can read its replies.

**Health:** `GET /healthz` needs no token. The temporary URL depends on the Mac and tunnel staying online.

# Endpoints

| Method and path | Input or result |
| --- | --- |
| `GET /api/products` | Optional `query`, `merchant`, `offset`, `limit` (default 20, max 50). Returns `{ products, total, next_offset }`. |
| `GET /api/products/:product_id` | Returns `{ product, capture_date }`. |
| `GET /api/products/:product_id/pictures/:index` | Image bytes; index starts at 1. |
| `POST /api/inquiries` | JSON `{ request_id, product_id }` → `{ created, inquiry }`. |
| `GET /api/inquiries/:id` | Returns `{ inquiry, replies }`. |

# Try it

Run from your backend terminal. Generate one UUID for an intentional inquiry and reuse it on retries.

```sh
export SHOPPING_API_URL='https://rochester-tear-ensemble-float.trycloudflare.com'

curl --fail-with-body "$SHOPPING_API_URL/api/products?limit=20"

# Replace <UUID> once; keep the same value when retrying.
curl --fail-with-body -H 'Content-Type: application/json' \
  -d '{"request_id":"<UUID>","product_id":"demo-supasonk"}' \
  "$SHOPPING_API_URL/api/inquiries"

# Replace <inquiry.id> with the ID returned above.
curl --fail-with-body "$SHOPPING_API_URL/api/inquiries/<inquiry.id>"
```

# Integration notes

- Only `demo-supasonk` accepts inquiries, routed to `@supasonk`. The 43 catalog products are browse-only for now; their inquiry requests return 404.

- New inquiries return 201; identical retries return 200 with the same ID. Save `inquiry.id` against the buyer’s session and poll about every 2 seconds while waiting.

- Status: `queued` → `claimed` → `sent` or `needs_attention`. Replies appear in `replies[].text` and `replies[].qr_image_url`; there is no `replied` status. A separate operator worker must process the queue.

- Product lists include `image_url`, `image_urls`, and `picture_count`. Resolve image paths against the base URL; images work directly in `<img src>` without a token.

- Backend calls work directly. Browser fetch requires the exact frontend origin in `POC_ALLOWED_ORIGINS` on buyer port `4319`, or use your backend as a proxy.

- Errors return `{ error: { code, message } }`. Common statuses: 400 invalid input, 403 origin, 404 unknown product or inquiry, 409 conflicting retry.
