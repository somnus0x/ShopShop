# Instagram shopping Events POC

An MCP server and SQLite queue for one authorized test DM to **@supasonk**. The server emits `inquiry.created`; a subscribed OpenAI Work Cloud agent can then claim the inquiry and use an explicitly connected computer to send it. This backend never operates Instagram directly.

The same service also exposes a **REST API** for frontend requests and a polling computer-use worker. See [REST endpoints and integration examples](docs/rest-api.md) and the [REST worker prompt](docs/worker-prompt.txt). Existing MCP endpoints, event subscriptions and the database are retained.

For the running public Cloudflare URL, credentials setup, frontend calls and deployment notes, see the [Shopping API handoff](docs/handoff.md).

## Status and scope

Implemented: event discovery, signed callback verification, persistent subscriptions, a retrying outbox, and four MCP tools for reading/claiming/reporting inquiries. The recipient and test message are fixed. A stable inquiry ID and atomic claim guard against repeated sends after duplicate event delivery.

As of November 21, 2026, the private tunnel and ChatGPT plugin are installed. The managed tunnel runtime `shopping-poc` was verified running, healthy, ready, and successfully polling the OpenAI control plane. The [Work Cloud listener](https://chatgpt.com/c/6b012305-595c-83ec-9abb-7247227ed2da) successfully called `get_poc_status` and discovered `inquiry.created`, but three subscription attempts returned the ChatGPT task-service error `Unable to complete task request. Try again.` The listener is **inactive** with zero saved automations and zero local subscriptions. The final retry produced no server-side subscription diagnostic, suggesting failure before the request reached this server. Retry subscription from that listener after the task-service issue is resolved; do not recreate the tunnel or plugin. Connected-computer execution and the Instagram DM remain **unverified**. A successful local test or webhook acknowledgement is not evidence that a DM was sent. The product picker, merchant reply monitoring, QR forwarding, dedicated assistant account, and purchase flow are future work.

## Run locally

Requires Node.js 22.13+; Node 22 reports an experimental warning for its built-in SQLite API.

```sh
cd /Users/timeff/Code/sea-hackathon
npm ci
npm test
npm start
```

HTTP binds only to `127.0.0.1:4318`. `/healthz` is public locally; `POST /mcp` requires a bearer token stored in `.data/access-token`. MCP requests with an Origin header are rejected; buyer REST routes support an explicit origin allowlist described in the REST guide. Do not expose this single-owner test server to the public internet.

The private stdio entry point is `node src/server.mjs --stdio`; the calling process or private tunnel supplies its authentication boundary. Set `POC_DATA_DIR` to an absolute directory so every process opens the same database. Optional HTTP settings: `POC_PORT`, `POC_BEARER_TOKEN`.

## Connect the private server

OpenAI [MCP Events](https://developers.openai.com/plugins/build/mcp-events) requires a supported Work Cloud chat or dot. A normal local coding chat is not an event subscriber. [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) can carry MCP calls to a local server without an inbound public port; computer access is a separate connection.

The current private connection is:

| Setting | Value |
| --- | --- |
| Tunnel | `tunnel_6b0120bf57c8819197b1981130b7c8b9` |
| ChatGPT plugin | [sea-hackathon shopping Events POC](https://chatgpt.com/plugins/plugin_asdk_app_6b0122bccab4819194b00f95913cbb7c) |
| Managed runtime alias | `shopping-poc` |
| Client | `/Users/timeff/Code/sea-hackathon/.data/tunnel-client-v0.0.21/tunnel-client` |
| Profile | `/Users/timeff/Code/sea-hackathon/.data/tunnel-profiles/shopping-poc.yaml` |
| Runtime key reference | `file:/Users/timeff/Code/sea-hackathon/.data/tunnel-runtime-key` |
| Stdio wrapper | `/bin/sh /Users/timeff/Code/sea-hackathon/scripts/start-mcp-stdio.sh` |

The official macOS arm64 client v0.0.21 was installed after Homebrew failed because of outdated Command Line Tools. The downloaded archive's SHA256 was verified as `353a535d2513f599f9fe7897606e89b3248611453b30203ebddfb6e62fd4f58b` against the [official release](https://github.com/openai/tunnel-client/releases/tag/v0.0.21). The wrapper pins `/usr/local/bin/node` and `POC_DATA_DIR=/Users/timeff/Code/sea-hackathon/.data`, so the tunnel child and HTTP server use the same SQLite database.

The seven-day runtime key was created on **November 21, 2026** and expires on **November 28, 2026**. Renew it before expiry and restart the managed runtime. Its file is private; the profile contains only the file reference. Keep the key out of chat, logs, screenshots, source control, and shared artifacts. Manage tunnel/workspace associations in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).

Check the managed runtime and local subscription state:

```sh
cd /Users/timeff/Code/sea-hackathon
.data/tunnel-client-v0.0.21/tunnel-client runtimes status shopping-poc --json
npm run poc -- status
```

To restart, stop the existing runtime before reconnecting; only one active stdio tunnel runtime should use this tunnel ID:

```sh
cd /Users/timeff/Code/sea-hackathon
.data/tunnel-client-v0.0.21/tunnel-client runtimes stop shopping-poc --json
.data/tunnel-client-v0.0.21/tunnel-client runtimes connect \
  --alias shopping-poc \
  --profile shopping-poc \
  --profile-dir /Users/timeff/Code/sea-hackathon/.data/tunnel-profiles \
  --tunnel-id tunnel_6b0120bf57c8819197b1981130b7c8b9 \
  --runtime-api-key file:/Users/timeff/Code/sea-hackathon/.data/tunnel-runtime-key \
  --mcp-command "/bin/sh /Users/timeff/Code/sea-hackathon/scripts/start-mcp-stdio.sh" \
  --json
.data/tunnel-client-v0.0.21/tunnel-client runtimes status shopping-poc --json
```

Verify the returned `process_running`, `healthy`, and `ready` values, and check control-plane polling separately. The health listener uses an ephemeral loopback port; use the health URL reported by runtime status. Keep this Mac awake and the runtime running for plugin discovery and MCP calls.

To complete the agent connection in the sea-hackathon space, use a supported Work Cloud chat with the installed private plugin enabled. For this event flow, verify that discovery includes `inquiry.created`, `get_poc_status`, `get_inquiry`, `claim_inquiry`, and `record_inquiry_result`. Connect this Mac separately and confirm Computer Use is available, then submit `docs/work-cloud-prompt.txt`. Verify `active_subscriptions` is greater than zero before triggering the test. Installing the plugin or starting the tunnel does not itself create the event subscription or send a DM.

## Connect a product MCP

The buyer endpoint is `http://127.0.0.1:4318/buyer/mcp` (Streamable HTTP). It uses a separate bearer credential in `.data/buyer-access-token`. Keep the credential on the product MCP backend. A remote integration needs its own private connection. For a separate tunnel, point its stdio target to `node src/server.mjs --stdio --buyer` with the same absolute `POC_DATA_DIR`; keep the operator plugin private.

The buyer and operator MCP servers expose two read-only tools backed by the November 21, 2026 Instagram catalog. It includes 43 products and 64 saved photos.

| Tool | Example arguments | Result |
| --- | --- | --- |
| `list_products` | `{"merchant":"overhills.th","query":"Loadlite"}` | Matching `product_id` values, names, merchants, prices, and picture counts. Use `limit` and the returned `next_offset` to page through results. |
| `get_product` | `{"product_id":"overhills-loadlite-5-shorts","picture_index":1}` | Structured product details and one image content block. The default is picture 1. The result lists the other picture indexes, their descriptions, and their source posts. |

Read the details from `structuredContent.product` and the photo from the `content` block with `type: "image"`. Its `data` is base64 and its `mimeType` identifies the format. Prices reflect the source post, and a null price can indicate a missing or conflicting price. The bundled catalog is `catalog/instagram/catalog.json`. To use another snapshot, set `POC_PRODUCT_DETAILS_CATALOG` to its absolute path. The snapshot uses the same JSON format with image paths relative to the JSON file and JPEG, PNG, or WebP pictures of up to 1 MiB each. Restart the MCP process to load an updated snapshot.

Configure the product-to-merchant mapping in `.data/product-catalog.json`, or set `POC_PRODUCT_CATALOG` to an absolute file path. Restart the entry point after changing the mapping. The local demo entry is:

```json
[
  {"product_id":"demo-supasonk","name":"SEA Hackathon demo product","merchant":"supasonk"}
]
```

On a product click, call `submit_product_inquiry` with `product_id` and a UUID `request_id`. Reuse that UUID for retries. Store the returned `inquiry.id` against the buyer's session and call `get_product_inquiry` with that ID to render status, reply text, and any recorded QR image URL. New IDs are private and only the requester should receive the inquiry ID and results.

The operator endpoint exposes `claim_product_inquiry`, `record_product_inquiry_send`, and `record_product_merchant_reply`. Claim only when ready to send, verify the recipient in Computer Use on the Mac, and record `sent` after verifying the outgoing message. Use `needs_attention` for an uncertain send. Record each verified inbound reply against its exact inquiry and merchant, with a stable message ID, plus text or an authorized HTTPS QR image URL. The buyer endpoint returns recorded replies and links. An unattended worker and Instagram attachment transfer are still needed. Product inquiries use a separate queue from the fixed MCP Events test below.

## Trigger the authorized test

```sh
npm run poc -- status
npm run poc -- trigger
npm run poc -- inquiry
```

`trigger` refuses to enqueue anything until a subscription exists. It always uses `poc-supasonk-001`, so repeating the command does not create another event. No replay is advertised; subscribe before creating the test. If a send becomes uncertain, inspect the Instagram conversation manually and do not reset the claim blindly.

The exact message is:

> Hi Supason! This is an AI-assisted shopping assistant test, sent with permission from this account’s owner. Could you reply “test received”? This is only a test; no purchase or payment is involved.

## Database and execution

Schema: `db/schema.sql`. Live database: `.data/shopping-poc.sqlite`, stored locally with restricted file permissions. The `subscriptions` table contains callback signing secrets, so the live database is not a shareable artifact.

| Table | Role |
| --- | --- |
| `inquiries` | Exact recipient/message; pending → claimed → sent, failed, or needs_attention; claim token and agent-reported evidence. |
| `subscriptions` | Owner, filter, callback URL, secret, expiration and active state. |
| `event_outbox` | One serialized event per inquiry, created in the same transaction. |
| `deliveries` | Per-subscription delivery status, attempts, next retry and HTTP result. |

Webhook delivery retries transient failures up to five attempts. The same event ID is reused; each attempt is signed again. A 30-second lease coordinates workers. An inquiry claim never expires automatically, avoiding an automatic second send after an uncertain first attempt. `sent` is the executing agent's report, not an independent Instagram receipt.

The POC uses a single local owner and plaintext secrets protected by filesystem permissions. Production work includes per-user authorization, encrypted secret storage and rotation overlap, retention, account isolation, operational monitoring, merchant reply handling and product/payment data models. Browser automation reliability and platform acceptance must be validated before expanding beyond the authorized test.

## Validation

`npm test` exercises real MCP request handling, local HTTP transport, product discovery and image responses, and simulated webhook receivers for signatures, challenges, retry identity, subscription stop/expiry, database restart, and duplicate-send protection. The tests cover standard MCP `_meta` compatibility and check that diagnostics exclude secrets, callback URLs, response bodies, and metadata values.
