import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, DEFAULT_DB } from './db.mjs';
import { EventService } from './events.mjs';
import { createMcpServer } from './mcp.mjs';
import { loadCatalog, ProductInquiries, registerProductBuyerHandlers } from './product-inquiries.mjs';
import { loadProductDetails } from './product-catalog.mjs';
import { createRestHandler } from './rest.mjs';

function buyerServer(productInquiries, productDetails) {
  const server = new Server({ name: 'sea-hackathon-product-intake', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerProductBuyerHandlers(server, productInquiries, productDetails);
  return server;
}

export async function startHttp({ store, events, token, buyerToken, productInquiries, productDetails, buyerOnly = false, publicBuyerRest = false, port = 4318, allowedOrigins = [] }) {
  if (buyerToken && buyerToken === token) throw new Error('Buyer and operator tokens must differ');
  if (buyerOnly && (!buyerToken || !productInquiries)) throw new Error('Buyer-only HTTP requires a buyer credential and product intake');
  const rest = createRestHandler({ store, token, buyerToken, productInquiries, productDetails, buyerOnly, publicBuyerRest, allowedOrigins });
  const listener = http.createServer(async (request, response) => {
    if (await rest(request, response)) return;
    const isBuyer = request.url === '/buyer/mcp';
    if (buyerOnly && !isBuyer && request.url !== '/healthz') { response.writeHead(404).end(); return; }
    if (request.headers.origin) { response.writeHead(403).end(); return; }
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'shopping-events-poc' }));
      return;
    }
    if (isBuyer && (!buyerToken || !productInquiries)) { response.writeHead(404).end(); return; }
    const expected = Buffer.from('Bearer ' + (isBuyer ? buyerToken : token));
    const provided = Buffer.from(request.headers.authorization || '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
      return;
    }
    if (!isBuyer && request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const mcp = isBuyer ? buyerServer(productInquiries, productDetails) : createMcpServer(store, events, { productInquiries, productDetails });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end('MCP transport failed');
    }
  });
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  return listener;
}

function loadToken(fileName, configuredToken) {
  const tokenPath = resolve(process.env.POC_DATA_DIR || '.data', fileName);
  let token = configuredToken;
  if (!token) {
    try { token = readFileSync(tokenPath, 'utf8').trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { writeFileSync(tokenPath, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
      token = readFileSync(tokenPath, 'utf8').trim();
    }
  }
  if (token.length < 24) throw new Error(fileName + ' must contain at least 24 characters');
  return token;
}

async function main() {
  const store = new Store();
  const events = new EventService(store);
  const catalogPath = process.env.POC_PRODUCT_CATALOG || resolve(process.env.POC_DATA_DIR || '.data', 'product-catalog.json');
  let catalog;
  try { catalog = loadCatalog(catalogPath); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.POC_PRODUCT_CATALOG) throw error;
    catalog = new Map();
  }
  const productInquiries = new ProductInquiries(store, catalog);
  const productDetails = loadProductDetails(process.env.POC_PRODUCT_DETAILS_CATALOG || undefined);
  let listener, mcp;
  if (process.argv.includes('--stdio')) {
    // For a private local client or OpenAI Secure MCP Tunnel. The enclosing
    // process/tunnel is the authenticated boundary; this opens no network port.
    mcp = process.argv.includes('--buyer') ? buyerServer(productInquiries, productDetails) : createMcpServer(store, events, { productInquiries, productDetails });
    await mcp.connect(new StdioServerTransport());
    console.error('Shopping Events POC running over stdio');
  } else {
    const buyerOnly = process.argv.includes('--buyer-http');
    const token = buyerOnly ? undefined : loadToken('access-token', process.env.POC_BEARER_TOKEN);
    const buyerToken = loadToken(buyerOnly ? 'public-buyer-access-token' : 'buyer-access-token', process.env.POC_BUYER_BEARER_TOKEN);
    listener = await startHttp({
      store, events, token, buyerToken, productInquiries, productDetails, buyerOnly,
      publicBuyerRest: process.env.POC_PUBLIC_BUYER_REST === '1',
      port: Number(process.env.POC_PORT || (buyerOnly ? 4319 : 4318)),
      allowedOrigins: (process.env.POC_ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean),
    });
    console.error('Shopping Events POC listening on http://127.0.0.1:' + listener.address().port + (buyerOnly ? '/buyer/mcp' : '/mcp'));
    console.error('REST API available on /api/products and /api/inquiries' + (buyerOnly ? '' : '; worker queue on /api/operator/inquiries'));
  }
  console.error('SQLite database: ' + DEFAULT_DB);
  const timer = process.argv.includes('--buyer-http') ? null
    : setInterval(() => void events.drain().catch(() => console.error('Delivery worker error')), 1000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (mcp) await mcp.close();
    if (listener) await new Promise(resolve => listener.close(resolve));
    // Process shutdown closes SQLite; pending delivery leases recover on restart.
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
