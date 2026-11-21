# REST API integration

The REST routes run alongside the existing MCP endpoints. Your frontend can browse products, queue inquiries and read results with ordinary HTTP requests. A separately running computer-use worker can poll and update the same SQLite queue through REST. Existing MCP clients, event subscriptions and tunnel configuration can continue to work.

```text
Frontend → REST API → SQLite queue ← REST API ← Computer-use worker → Instagram
```

The service does not launch a worker or send Instagram messages. Starting the API does not start an unattended Instagram loop.

The public buyer API is at **https://rochester-tear-ensemble-float.trycloudflare.com**. Hackathon mode enables buyer REST requests without a token using `POC_PUBLIC_BUYER_REST=1`. See the [Shopping API handoff](handoff.md) for the deployed connection, browser configuration and current demo-only inquiry mapping. Worker routes remain local on port `4318` and require the operator token.

## Run and connect

Requires Node.js 22.13+:

```sh
cd /Users/timeff/Code/sea-hackathon
npm ci
npm test
npm start
```

The API is at `http://127.0.0.1:4318`. `GET /healthz` is public. By default, all REST `/api` routes require `Authorization: Bearer <token>`. Setting `POC_PUBLIC_BUYER_REST=1` removes authentication only for buyer REST routes, including images and inquiry results. Operator REST and MCP endpoints still require their credentials:

| Credential | File | REST access |
| --- | --- | --- |
| Buyer | `.data/buyer-access-token` | Catalog, inquiry creation, inquiry status and replies |
| Operator | `.data/access-token` | Buyer routes plus worker queue, send results and reply recording |

Keep the operator token on the worker. In authenticated mode, keep the buyer token on your backend. Hackathon mode allows anyone with the URL to browse and submit inquiries, and anyone with an inquiry ID to read its results. Neither mode provides separate buyer accounts.

`node src/server.mjs --buyer-http` starts the separate buyer-only listener on port `4319`, using `.data/public-buyer-access-token` and the same database. It exposes buyer REST routes alongside `/buyer/mcp`, with no operator routes. A remote frontend backend needs an HTTPS reverse proxy or private network connection to reach this Mac. `localhost` on another device is not this service.

Start that listener in hackathon mode with `POC_PUBLIC_BUYER_REST=1 node src/server.mjs --buyer-http`. Remove the setting and restart to require buyer REST authentication again. The buyer token remains required for `/buyer/mcp` in both modes.

## Frontend endpoints

Requests and responses use ordinary JSON. Send `Content-Type: application/json` on POST requests.

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /api/products` | Optional `query`, `merchant`, `offset`, `limit` query parameters | `{ products, total, next_offset }`; each product includes `image_url`, `image_urls` and `picture_count` |
| `GET /api/products/:product_id` | Catalog product ID | `{ product, capture_date }`; pictures contain indexes, descriptions, source posts and URLs |
| `GET /api/products/:product_id/pictures/:index` | 1-based picture index | JPEG, PNG or WebP bytes |
| `POST /api/inquiries` | `{ request_id, product_id }` | `{ created, inquiry }`; 201 for new work, 200 for a retry |
| `GET /api/inquiries/:id` | Private inquiry ID | `{ inquiry, replies }` with status, reply text and recorded QR image URLs |

Use a new UUID `request_id` for each intentional inquiry. Reuse it when retrying that inquiry, including after a timeout. Reusing a request ID for another product returns 409. Creating an inquiry only queues it.

Example for the frontend's **backend** using the public hackathon API. In authenticated mode, load `BUYER_API_TOKEN` from private configuration:

```js
const apiBase = process.env.SHOPPING_API_URL ?? 'https://rochester-tear-ensemble-float.trycloudflare.com';
const buyerToken = process.env.BUYER_API_TOKEN;

async function api(path, body) {
  const response = await fetch(apiBase + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(buyerToken ? { authorization: `Bearer ${buyerToken}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error.message);
  return result;
}

const page = await api('/api/products?merchant=overhills.th&query=Loadlite');
const product = page.products[0];
const imageUrl = new URL(product.image_url, apiBase).href;
const imageUrls = product.image_urls.map(path => new URL(path, apiBase).href);

// Persist this ID with the click before submitting, and reuse it on retries.
// Only the demo product is enabled for inquiries right now.
const requestId = crypto.randomUUID();
const queued = await api('/api/inquiries', {
  request_id: requestId,
  product_id: 'demo-supasonk',
});

// Store queued.inquiry.id against the buyer session. Poll this path as needed.
const statusPath = `/api/inquiries/${queued.inquiry.id}`;
const current = await api(statusPath);
```

The product list supplies `image_url` for the first picture and `image_urls` for all pictures, so no product-detail request is needed to discover the images. These URLs are relative to the API base, for example `/api/products/overhills-loadlite-5-shorts/pictures/1`. In hackathon mode, images need no token and can be used in `<img src>` after resolving the URL. In authenticated mode, proxy images through your backend or use authenticated `fetch` and a blob URL. Do not put tokens in query strings.

For direct browser calls during the demo, explicitly allow the frontend's origin:

```sh
POC_ALLOWED_ORIGINS=http://localhost:5173 npm start
```

Configured origins can use buyer REST routes and their preflight requests. The origin allowlist still applies in hackathon mode. Operator REST routes and the existing MCP routes reject browser origins. In authenticated mode, a backend proxy keeps the buyer token out of browser code.

For the public tunnel, set `POC_ALLOWED_ORIGINS` when restarting `node src/server.mjs --buyer-http` on port `4319`; setting it only on `npm start` affects port `4318`.

## Worker endpoints and loop

Use the operator token for these routes:

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /api/operator/status` | None | Service and queue status |
| `GET /api/operator/inquiries` | Optional `status`, `offset`, `limit` | `{ inquiries, total, next_offset }`; includes merchant and message, excludes claim tokens |
| `POST /api/operator/inquiries/claim` | `{}` | `{ inquiry, claim_token, message }`, or `{ inquiry: null }` when empty |
| `POST /api/operator/inquiries/:id/send` | `{ claim_token, outcome }` | Updated inquiry; outcome is `sent` or `needs_attention` |
| `POST /api/operator/inquiries/:id/replies` | `{ merchant, message_id, text?, qr_image_url? }` | `{ recorded }`; at least text or an HTTPS image URL is required |

The worker can follow this loop:

1. Confirm it has computer access, the intended Instagram account, and authorization for the queued recipients and messages.
2. When ready to handle one send, POST `{}` to the claim endpoint. If the queue is empty, wait about two seconds before polling again.
3. Verify the claimed merchant in Instagram, send the returned message once, and confirm it is visible in that conversation.
4. Record `sent` only after that confirmation. Record `needs_attention` when the outcome is uncertain. Never retry the Instagram send automatically.
5. Use `GET /api/operator/inquiries?status=sent` to find conversations to inspect for replies. Match each observed reply to its exact inquiry and merchant before recording it with a stable `message_id`.

REST and MCP use the same atomic claims. Claims do not expire: a crashed worker leaves a claimed inquiry for inspection, and another worker using either interface cannot claim it again. Retrying an identical result or reply request is safe. An API response of `sent` is the worker's report, not an independent Instagram receipt. The API stores QR links supplied by the worker; it does not upload Instagram attachments.

The worker needs access to both this REST service and the computer. A cloud worker cannot reach this Mac's loopback address without a separate network connection. See `docs/worker-prompt.txt` for REST worker instructions. The existing `docs/work-cloud-prompt.txt` continues to describe the MCP event test.

## Fixed test through REST

The original fixed test remains separate from product inquiries. An operator can create it by POSTing `{}` to `/api/operator/test-inquiries`, without requiring an event subscription for that REST call. Creating it does not send a message.

| Method and path | Input |
| --- | --- |
| `GET /api/operator/test-inquiries/poc-supasonk-001` | None |
| `POST /api/operator/test-inquiries/poc-supasonk-001/claim` | `{}` |
| `POST /api/operator/test-inquiries/poc-supasonk-001/result` | `{ claim_token, outcome, evidence }` |

Send only when the test is authorized and the claim response has `can_send: true`. The recipient remains `@supasonk`; use the exact stored message returned by the API. Result outcomes are `sent`, `failed`, or `needs_attention`. Repeated creation returns the same fixed inquiry without resetting it. The product claim route does not consume this separate test queue.

The existing `npm run poc -- trigger` workflow and its subscription precondition remain unchanged. If an MCP subscription is active, creating the fixed test can also notify that subscriber; both interfaces share the same claim guard.

## Configuration and existing data

Set environment variables in the shell or process manager; `.env.example` lists them. `npm start` does not automatically read `.env`.

| Variable | Default / purpose |
| --- | --- |
| `POC_DATA_DIR` | `.data`; use the same absolute path for every listener and CLI process |
| `POC_PORT` | `4318`, or `4319` with `--buyer-http` |
| `POC_BEARER_TOKEN` | Operator token; otherwise loaded or generated in `access-token` |
| `POC_BUYER_BEARER_TOKEN` | Buyer token; otherwise loaded or generated in the corresponding buyer token file |
| `POC_PUBLIC_BUYER_REST` | Default off; `1` makes buyer REST routes public for the hackathon. Operator and MCP authentication remain enabled. |
| `POC_ALLOWED_ORIGINS` | Empty; comma-separated exact browser origins for buyer REST routes |
| `POC_PRODUCT_DETAILS_CATALOG` | `catalog/instagram/catalog.json` |
| `POC_PRODUCT_CATALOG` | Product-to-merchant mapping, normally `.data/product-catalog.json` |

The bundled November 21, 2026 catalog contains 43 products and 64 photos. Prices are a saved snapshot, not live inventory. An existing inquiry mapping is respected: a browsable product is accepted for inquiry only if its ID is present in that mapping. If the default mapping file is absent, no products are enabled for inquiry until you configure it. For example, the earlier test mapping is:

```json
[
  { "product_id": "demo-supasonk", "name": "SEA Hackathon demo product", "merchant": "supasonk" }
]
```

Restart after changing either catalog. Details catalog images must be relative JPEG, PNG or WebP files within its directory, up to 1 MiB each.

The existing `.data/shopping-poc.sqlite`, inquiries, merchant replies, event tables and credentials remain in place. No data deletion or claim resets are part of adding REST. Existing `/mcp`, `/buyer/mcp`, stdio, subscriptions and tunnel support are retained.

## Errors and verification

Errors use `{ "error": { "code": "...", "message": "..." } }` with an HTTP status:

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON, fields or query parameters |
| 401 | Missing or incorrect credential for the route |
| 403 | Browser origin is not allowed |
| 404 | Unknown resource or route |
| 405 | Unsupported method |
| 409 | Conflicting request ID, claim, result or reply |
| 413 | Request body exceeds 16 KiB |
| 415 | POST body is not JSON |

`npm test` covers REST integration and existing MCP behavior locally. It does not send Instagram messages or prove that a worker is running.
