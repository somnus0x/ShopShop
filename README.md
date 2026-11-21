# shopshop in ChatGPT

Shopshop suggests a first-date gift from the interests someone has shared on Instagram or Facebook. In the fictional June demo, two fitness posts and one travel post lead to Rally Movement’s ฿590 Clover bag charm. The recipient can carry a small good-luck wish on the same backpack she takes to races and on trips.

Open `index.html` for a standalone design preview. To see the card inside a conversation and send the chosen gift and note back to ChatGPT, connect the MCP server below.

## Hackathon setup on Railway

1. In Railway, choose **New Project → Deploy from GitHub repo → somnus0x/ShopShop**. The repository root contains the Dockerfile and `railway.toml`. Railway injects `PORT`, and `/healthz` checks startup. In the service settings, generate a public domain. With the CLI, run `railway up` from the application directory, then `railway domain`. [Railway deployment](https://docs.railway.com/cli/up) · [Railway domains](https://docs.railway.com/cli/domain)
2. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **+ → Add custom MCP server**. Enter the Railway HTTPS URL with `/mcp` appended, name it **ShopShop**, and use **No authentication** for the demo server. Create and install the plugin. [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
3. Add `APIFY_TOKEN` in Railway Variables. In a new conversation, mention `@shopshop`, then paste the actual public Instagram profile URL you want to test and ask for a gift under ฿600. Check that the overview shows the pasted handle, that its post images match the originals, and that the gift explanation cites the posts. The scraper requests up to 30 recent public posts per lookup with a $0.10 Apify charge cap. ChatGPT selects up to six supporting posts for the gift. Successful and empty results are cached for five minutes in the server process. Set a usage limit in Apify for the demo. Private or unreadable profiles prompt for screenshots. [Apify Actor](https://apify.com/apify/instagram-post-scraper) · [Apify API](https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items)

### Adjust the Instagram scan

Set either variable in Railway and deploy the changes. Every lookup uses the configured post limit and charge cap.

| Railway variable | Default | What it controls |
| --- | --- | --- |
| `SHOPSHOP_APIFY_POST_LIMIT` | `30` | Recent posts requested per public profile. Accepts 1 through 2,000. |
| `SHOPSHOP_APIFY_MAX_CHARGE_USD` | `0.10` | Positive USD spending cap per Apify run. Increase it alongside the post limit to retrieve more rows. |

For example, set the post limit to `100` and the cap to `0.30`. The charge cap, the scraper timeout, and the number of available public posts can reduce the returned count. [Apify Post Scraper pricing](https://apify.com/apify/instagram-post-scraper)

### Connect the merchant inquiry demo

The inquiry panel appears on the profile overview when the buyer bridge is configured. It submits the separate Supason demo product `demo-supasonk`; the Clover remains a visual gift recommendation. The operator uses the existing shopping queue to send and record the reply. The widget refreshes the original inquiry using a signed ticket and reuses its request ID if the initial button click needs retrying.

| Railway variable | Value |
| --- | --- |
| `SHOPSHOP_BUYER_URL` | Private route from Railway to the shopping Mac’s `/buyer/mcp` endpoint |
| `SHOPSHOP_BUYER_TOKEN` | The buyer-only bearer credential from the shopping operator |
| `SHOPSHOP_INQUIRY_SECRET` | Random server-only key for signing inquiry tickets |
| `SHOPSHOP_BUYER_DEMO_CODE` | Separate high-entropy demo code to enter in the widget before sending |
| `SHOPSHOP_QR_ORIGIN` | HTTPS origin of the operator-approved sample QR host, if testing QR replies |

The shopping Mac’s loopback address is only reachable from that Mac. Test the private route from Railway before enabling the bridge. Use the buyer endpoint credentials for this integration. Use sample QR images without payment details.

## Connect a private demo to ChatGPT

1. In the directory containing `server.py`, install the dependencies.

   ```sh
   uv venv --python 3.13
   uv pip install -r requirements.txt
   ```

2. Create a Secure MCP Tunnel associated with the target ChatGPT workspace, install OpenAI’s `tunnel-client`, and provide its runtime key through the `CONTROL_PLANE_API_KEY` environment variable. Set `SHOPSHOP_TUNNEL_ID` to the tunnel ID shown in Platform. [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) · [OpenAI tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

3. Run these commands in the same directory. The tunnel launches the Python server over stdio. Keep the last command running during the demo.

   ```sh
   tunnel-client init --sample sample_mcp_stdio_local --profile shopshop \
     --tunnel-id "$SHOPSHOP_TUNNEL_ID" \
     --mcp-command "\"$PWD/.venv/bin/python\" \"$PWD/server.py\" --stdio"
   tunnel-client doctor --profile shopshop --explain
   tunnel-client run --profile shopshop
   ```

4. In ChatGPT on the web, open **Plugins → + → Add custom MCP server**. Name it **shopshop**, choose **Tunnel**, select the tunnel from step 2, and choose **No authentication** for this prototype. Review the warning, select **Create as a plugin**, then install it. The tool list should include `source_gifts`. Workspace access to custom MCP servers is required. [ChatGPT Plugins](https://chatgpt.com/plugins) · [OpenAI’s custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)

5. Start a new conversation, type `@`, select **shopshop**, and send this prompt.

   > ช่วยเลือกของขวัญจากโปรไฟล์ Instagram นี้ งบ 600 บาท

   Paste the public profile URL in the same message.

   Expect a recap and gift recommendation for the handle you supplied. Tap a graph entry to read the supporting post. Choose **ใส่ช่องของขวัญ**, edit the note, then press **ส่งของที่เลือกกับโน้ตเข้าแชต** to send your selection. **แชร์การ์ดนี้** opens the phone’s share sheet or a saveable 1080 × 1350 PNG.

For a hosted connection, run `.venv/bin/python server.py` with the HTTP transport and expose its `/mcp` route through your HTTPS ingress. The local default is `http://127.0.0.1:8000/mcp`. The process accepts `HOST` and `PORT` from the environment. In step 4 choose **Server URL** and enter your reachable HTTPS URL including `/mcp`. GitHub hosts the source files. A running MCP endpoint or tunnel is required for interactive ChatGPT use. After changing the tool schema or UI resource, restart the server, choose **Refresh** in the ChatGPT plugin, and start a new conversation. [Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Where the evidence and photos come from

For a personal profile, supply its URL and up to six captions or post screenshots. The URL identifies the profile. ChatGPT passes the supported cues and caption text to `source_gifts`. Topic counts reflect the supplied posts. Place labels distinguish a favorite from a past visit or future plan. A bare profile URL prompts for evidence.

For a private demo with a participating brand or creator, connect one professional account using [Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login). Give the Instagram user token the `instagram_business_basic` permission. Set these variables for the process that launches `server.py`.

| Variable | Value |
| --- | --- |
| `SHOPSHOP_IG_ACCOUNT_ID` | Instagram professional account’s numeric user ID from Meta |
| `SHOPSHOP_IG_ACCESS_TOKEN` | That account’s Instagram user access token |

Restart the plugin and refresh its tools. In chat, ask `@shopshop` to import a gift profile from the connected account URL. The `read_instagram_posts` tool verifies the handle against the authorized account and reads up to six recent captions and permalinks. `source_gifts` checks the selected excerpts against those captions and shows photos or video thumbnails alongside their source posts. The token stays in the server environment. Set it only for a private or access-controlled deployment with permission to display the account’s posts. This setup uses one configured account per server. For personal profiles, share the posts directly as screenshots or pasted captions. Instagram oEmbed serves public-post embeds and has removed thumbnail URLs. [Meta media reference](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/v21.0/) · [Meta oEmbed changes](https://developers.facebook.com/docs/graph-api/changelog/non-versioned-changes/nvc-2025)

For an external image host, allow its HTTPS origin in the widget resource’s `_meta.ui.csp.resourceDomains`. If the widget fetches image bytes with JavaScript, declare the fetch origin in `connectDomains` as well. Keep Instagram authorization tokens on the server. ChatGPT also supports temporary download URLs for authorized file IDs. The share export uses the fictional demo avatar, interest graph and gift, with the Clover photo labeled as a mockup. It omits private notes, profile links, raw captions, and source-post photographs. [OpenAI widget and file reference](https://developers.openai.com/plugins/reference)

## Update the design

Edit `story.html`, `story.css`, `story.js`, and `recap.js`, then regenerate the standalone preview with `.venv/bin/python server.py --preview`. Catalog prices and source links live in `brand-corpus.json`. Gift pairings and their explanations live in `story_data.py`.

What Brandon Thinks informed the initial reveal, Snapchat inspired tap-through navigation, and Mobbin’s shopping flows informed the gift selection and confirmation. [What Brandon Thinks](https://www.whatbrandonthinks.com/) · [Snapchat Stories](https://help.snapchat.com/hc/en-gb/articles/7012308547092-How-do-I-view-a-friend-s-Story-on-Snapchat) · [Mobbin shopping flows](https://mobbin.com/explore/mobile/flows/adding-to-cart-bag)
