import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/db.mjs';
import { ProductInquiries } from '../src/product-inquiries.mjs';
import { loadProductDetails } from '../src/product-catalog.mjs';
import { startHttp } from '../src/server.mjs';

const inquiryCatalog = () => new Map([
  ['demo', { product_id: 'demo', name: 'Demo product', merchant: 'supasonk' }],
  ['second', { product_id: 'second', name: 'Second product', merchant: 'other.shop' }],
]);

async function service(t, options = {}) {
  const store = options.store ?? new Store(':memory:');
  const token = randomBytes(32).toString('base64url');
  const buyerToken = randomBytes(32).toString('base64url');
  const productInquiries = new ProductInquiries(store, inquiryCatalog());
  const listener = await startHttp({
    store, token, buyerToken, productInquiries, productDetails: loadProductDetails(), port: 0, ...options,
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    store.close();
  }
  t.after(close);
  const base = 'http://127.0.0.1:' + listener.address().port;
  async function request(path, { method = 'GET', role = 'buyer', body, headers = {}, rawBody } = {}) {
    const credential = role === 'operator' ? token : role === 'buyer' ? buyerToken : role;
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(credential ? { authorization: 'Bearer ' + credential } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    return response;
  }
  async function json(path, options = {}, expected = 200) {
    const response = await request(path, options);
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  return { store, base, token, buyerToken, request, json, close };
}

const post = (body = {}, role = 'operator') => ({ method: 'POST', role, body });
async function submit(api, product_id = 'demo', request_id = randomUUID()) {
  return api.json('/api/inquiries', post({ product_id, request_id }, 'buyer'), 201);
}
async function expectError(api, path, options, status) {
  const value = await api.json(path, options, status);
  assert.equal(typeof value.error.code, 'string');
  assert.equal(typeof value.error.message, 'string');
  return value;
}

test('REST authentication separates frontend access from operator actions', async t => {
  const api = await service(t);
  assert.equal((await api.request('/healthz', { role: null })).status, 200);
  await expectError(api, '/api/products', { role: null }, 401);
  await expectError(api, '/api/products', { role: 'invalid-credential' }, 401);
  await expectError(api, '/api/operator/status', {}, 401);
  await expectError(api, '/api/operator/inquiries/claim', post({}, 'buyer'), 401);
  assert.equal((await api.request('/api/products', { role: 'operator' })).status, 200);
  assert.equal((await api.request('/api/operator/status', { role: 'operator' })).status, 200);

  const buyer = await service(t, { buyerOnly: true });
  assert.equal((await buyer.request('/api/products')).status, 200);
  assert.equal((await buyer.request('/api/operator/status', { role: 'operator' })).status, 404);
  assert.equal((await buyer.request('/api/operator/inquiries/claim', post())).status, 404);
});

test('public buyer REST supports anonymous shopping without exposing operator controls or MCP', async t => {
  for (const buyerOnly of [false, true]) {
    const origin = 'http://localhost:5173';
    const api = await service(t, { publicBuyerRest: true, buyerOnly, allowedOrigins: [origin] });
    const products = await api.json('/api/products?limit=1', { role: null });
    const product = products.products[0];
    const detail = await api.json('/api/products/' + product.product_id, { role: null });
    assert.equal(detail.product.product_id, product.product_id);
    const picture = await api.request(product.image_url, { role: null });
    assert.equal(picture.status, 200);
    assert.ok((await picture.arrayBuffer()).byteLength > 0);

    const body = { request_id: randomUUID(), product_id: 'demo' };
    const queued = await api.json('/api/inquiries', post(body, null), 201);
    const retry = await api.json('/api/inquiries', post(body, null));
    assert.equal(retry.created, false);
    assert.equal(retry.inquiry.id, queued.inquiry.id);
    const current = await api.json('/api/inquiries/' + queued.inquiry.id, { role: null });
    assert.equal(current.inquiry.status, 'queued');
    assert.deepEqual(current.replies, []);

    const browser = await api.request('/api/products', { role: null, headers: { origin } });
    assert.equal(browser.status, 200);
    assert.equal(browser.headers.get('access-control-allow-origin'), origin);
    await expectError(api, '/api/products', { role: null, headers: { origin: 'https://untrusted.example' } }, 403);
    await expectError(api, '/api/operator/status', { role: null }, buyerOnly ? 404 : 401);
    await expectError(api, '/api/operator/inquiries/claim', post({}, null), buyerOnly ? 404 : 401);
    await expectError(api, '/api/operator/inquiries/claim', post({}, 'buyer'), buyerOnly ? 404 : 401);
    for (const path of ['/send', '/replies']) {
      await expectError(api, '/api/operator/inquiries/' + queued.inquiry.id + path, post({}, null), buyerOnly ? 404 : 401);
    }
    assert.equal((await api.request('/buyer/mcp', post({}, null))).status, 401);
    assert.equal((await api.request('/mcp', post({}, null))).status, buyerOnly ? 404 : 401);
  }
});

test('explicit CORS origins support browser fetch and preflight without granting worker access', async t => {
  const origin = 'http://localhost:5173';
  const api = await service(t, { allowedOrigins: [origin] });
  const preflight = await api.request('/api/inquiries', {
    method: 'OPTIONS', role: null,
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
  const response = await api.request('/api/products', { headers: { origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.match(response.headers.get('vary'), /origin/i);
  await expectError(api, '/api/products', { role: null, headers: { origin } }, 401);
  await expectError(api, '/api/products', { headers: { origin: 'https://untrusted.example' } }, 403);
  await expectError(api, '/api/operator/status', { role: 'operator', headers: { origin } }, 403);
  assert.equal((await api.request('/api/operator/inquiries/claim', {
    method: 'OPTIONS', role: null, headers: { origin, 'access-control-request-method': 'POST' },
  })).status, 403);
  for (const [path, role] of [['/mcp', 'operator'], ['/buyer/mcp', 'buyer']]) {
    const legacy = await api.request(path, { ...post({}, role), headers: { origin } });
    assert.equal(legacy.status, 403);
    assert.equal(legacy.headers.get('access-control-allow-origin'), null);
  }
  const defaultApi = await service(t);
  await expectError(defaultApi, '/api/products', { headers: { origin } }, 403);
});

test('catalog REST resources return JSON details and real picture bytes', async t => {
  const api = await service(t);
  const first = await api.json('/api/products?limit=2');
  assert.equal(first.products.length, 2);
  assert.equal(first.next_offset, 2);
  for (const product of first.products) {
    assert.equal(product.image_url, product.image_urls[0]);
    assert.equal(product.image_urls.length, product.picture_count);
  }
  const second = await api.json('/api/products?limit=2&offset=2');
  assert.notEqual(first.products[0].product_id, second.products[0].product_id);
  const matches = await api.json('/api/products?query=loadlite&merchant=%40Overhills.th');
  assert.equal(matches.total, 1);
  const { product_id, image_url, image_urls } = matches.products[0];
  const picture = await api.request(image_url);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await picture.arrayBuffer());
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  const detail = await api.json('/api/products/' + product_id);
  assert.equal(detail.product.product_id, product_id);
  assert.equal(detail.product.price, 1090);
  assert.equal(detail.product.pictures[0].picture_index, 1);
  assert.match(detail.product.pictures[0].url, /\/api\/products\//);
  assert.deepEqual(image_urls, detail.product.pictures.map(picture => picture.url));
  assert.equal(JSON.stringify(detail).includes('local_path'), false);
  assert.equal(JSON.stringify(detail).includes('structuredContent'), false);
  const alternate = await api.request(image_urls[1]);
  assert.equal(alternate.status, 200);
  assert.notDeepEqual(Buffer.from(await alternate.arrayBuffer()), bytes);
  await expectError(api, '/api/products/missing', {}, 404);
  await expectError(api, '/api/products/' + product_id + '/pictures/99', {}, 404);
});

test('frontend submission, worker send and merchant reply form an idempotent REST lifecycle', async t => {
  const api = await service(t);
  const request_id = randomUUID();
  const queued = await submit(api, 'demo', request_id);
  assert.equal(queued.created, true);
  assert.equal(queued.inquiry.status, 'queued');
  const id = queued.inquiry.id;
  const retry = await api.json('/api/inquiries', post({ request_id, product_id: 'demo' }, 'buyer'));
  assert.equal(retry.created, false);
  assert.equal(retry.inquiry.id, id);
  await expectError(api, '/api/inquiries', post({ request_id, product_id: 'second' }, 'buyer'), 409);
  await expectError(api, '/api/inquiries', post({ request_id: randomUUID(), product_id: 'missing' }, 'buyer'), 404);
  const claim = await api.json('/api/operator/inquiries/claim', post());
  assert.equal(claim.inquiry.id, id);
  assert.equal(claim.inquiry.merchant, 'supasonk');
  assert.match(claim.message, /Demo product/);
  assert.ok(claim.message.includes(id));
  assert.equal((await api.json('/api/operator/inquiries/claim', post())).inquiry, null);
  await expectError(api, '/api/operator/inquiries/' + id + '/send', post({ claim_token: randomUUID(), outcome: 'sent' }), 409);
  const send = { claim_token: claim.claim_token, outcome: 'sent' };
  assert.equal((await api.json('/api/operator/inquiries/' + id + '/send', post(send))).inquiry.status, 'sent');
  assert.equal((await api.json('/api/operator/inquiries/' + id + '/send', post(send))).inquiry.status, 'sent');
  await expectError(api, '/api/operator/inquiries/' + id + '/send', post({ ...send, outcome: 'needs_attention' }), 409);
  const reply = { merchant: 'supasonk', message_id: 'reply-1', text: 'Available', qr_image_url: 'https://example.com/qr.png' };
  const replyPath = '/api/operator/inquiries/' + id + '/replies';
  await expectError(api, replyPath, post({ ...reply, merchant: 'wrong' }), 409);
  assert.equal((await api.json(replyPath, post(reply))).recorded, true);
  assert.equal((await api.json(replyPath, post(reply))).recorded, false);
  await expectError(api, replyPath, post({ ...reply, text: 'Different reply' }), 409);
  const view = await api.json('/api/inquiries/' + id);
  assert.equal(view.inquiry.status, 'sent');
  assert.equal(view.replies.length, 1);
  assert.equal(view.replies[0].text, reply.text);
  assert.equal(view.replies[0].qr_image_url, reply.qr_image_url);
  assert.equal(JSON.stringify(view).includes(claim.claim_token), false);
  assert.equal(view.inquiry.claim_token, undefined);
});

test('simultaneous retries and competing workers reserve each inquiry only once', async t => {
  const api = await service(t);
  const request_id = randomUUID();
  const requests = await Promise.all(Array.from({ length: 8 }, () => api.request('/api/inquiries', post({ request_id, product_id: 'demo' }, 'buyer'))));
  assert.equal(requests.filter(response => response.status === 201).length, 1);
  assert.equal(requests.filter(response => response.status === 200).length, 7);
  const submissions = await Promise.all(requests.map(response => response.json()));
  assert.equal(new Set(submissions.map(result => result.inquiry.id)).size, 1);
  await submit(api, 'second');
  const claims = await Promise.all(Array.from({ length: 8 }, () => api.json('/api/operator/inquiries/claim', post())));
  const reserved = claims.filter(claim => claim.inquiry);
  assert.equal(reserved.length, 2);
  assert.equal(new Set(reserved.map(claim => claim.inquiry.id)).size, 2);
  assert.equal(new Set(reserved.map(claim => claim.claim_token)).size, 2);
});

test('worker queue listing supports polling and reply monitoring without exposing claim tokens', async t => {
  const api = await service(t);
  const queued = await submit(api);
  await submit(api, 'second');
  const before = await api.json('/api/operator/inquiries?status=queued&limit=1', { role: 'operator' });
  assert.equal(before.total, 2);
  assert.equal(before.inquiries.length, 1);
  assert.equal(before.next_offset, 1);
  assert.equal(before.inquiries[0].merchant, 'supasonk');
  assert.ok(before.inquiries[0].message.includes(queued.inquiry.id));
  const claim = await api.json('/api/operator/inquiries/claim', post());
  const path = '/api/operator/inquiries/' + claim.inquiry.id + '/send';
  await api.json(path, post({ claim_token: claim.claim_token, outcome: 'sent' }));
  const sent = await api.json('/api/operator/inquiries?status=sent', { role: 'operator' });
  assert.equal(sent.total, 1);
  assert.equal(sent.inquiries[0].id, queued.inquiry.id);
  assert.equal(sent.inquiries[0].claim_token, undefined);
  assert.equal(JSON.stringify(sent).includes(claim.claim_token), false);
  const remaining = await api.json('/api/operator/inquiries?status=queued', { role: 'operator' });
  assert.equal(remaining.total, 1);
  assert.equal(remaining.inquiries[0].product_id, 'second');
});

test('REST errors reject invalid input, unsupported methods and oversized JSON', async t => {
  const api = await service(t);
  const invalid = [
    {},
    { request_id: 'not-a-uuid', product_id: 'demo' },
    { request_id: randomUUID(), product_id: '../demo' },
    { request_id: randomUUID(), product_id: 'demo', merchant: 'other' },
    [],
    null,
  ];
  for (const body of invalid) await expectError(api, '/api/inquiries', post(body, 'buyer'), 400);
  await expectError(api, '/api/inquiries', {
    method: 'POST', rawBody: '{not json', headers: { 'content-type': 'application/json' },
  }, 400);
  await expectError(api, '/api/inquiries', {
    method: 'POST', rawBody: '{}', headers: { 'content-type': 'text/plain' },
  }, 415);
  await expectError(api, '/api/inquiries', post({ text: 'x'.repeat(17 * 1024) }, 'buyer'), 413);
  await expectError(api, '/api/products?limit=0', {}, 400);
  await expectError(api, '/api/products?offset=-1', {}, 400);
  await expectError(api, '/api/products?limit=not-a-number', {}, 400);
  await expectError(api, '/api/operator/inquiries?status=unknown', { role: 'operator' }, 400);
  await expectError(api, '/api/inquiries/not-a-uuid', {}, 400);
  await expectError(api, '/api/inquiries/' + randomUUID(), {}, 404);
  await expectError(api, '/api/products', { method: 'DELETE' }, 405);
  await expectError(api, '/api/operator/inquiries/claim', post({ unexpected: true }), 400);
  const queued = await submit(api);
  const replyPath = '/api/operator/inquiries/' + queued.inquiry.id + '/replies';
  await expectError(api, replyPath, post({ merchant: 'supasonk', message_id: '1' }), 400);
  await expectError(api, replyPath, post({ merchant: 'supasonk', message_id: '1', qr_image_url: 'http://example.com/image.png' }), 400);
  await expectError(api, replyPath, post({ merchant: 'supasonk', message_id: '1', qr_image_url: 'https://secret@example.com/image.png' }), 400);
});

test('the fixed authorized test uses REST without an event subscription and cannot be claimed twice', async t => {
  const api = await service(t);
  const queuedResponse = await api.request('/api/operator/test-inquiries', post());
  assert.equal(queuedResponse.status, 201);
  const queued = await queuedResponse.json();
  assert.equal(queued.created, true);
  assert.equal(queued.inquiry.recipient, 'supasonk');
  const repeated = await api.json('/api/operator/test-inquiries', post());
  assert.equal(repeated.created, false);
  assert.equal(repeated.inquiry.id, queued.inquiry.id);
  const path = '/api/operator/test-inquiries/' + queued.inquiry.id;
  const details = await api.json(path, { role: 'operator' });
  assert.equal(details.recipient ?? details.inquiry?.recipient, 'supasonk');
  const claim = await api.json(path + '/claim', post());
  assert.equal(claim.can_send, true);
  assert.equal((await api.json(path + '/claim', post())).can_send, false);
  const result = { claim_token: claim.claim_token, outcome: 'sent', evidence: 'Test fixture: outgoing message observed.' };
  const complete = await api.json(path + '/result', post(result));
  assert.equal(complete.status ?? complete.inquiry?.status, 'sent');
  await api.json(path + '/result', post(result));
  await expectError(api, path + '/result', post({ ...result, outcome: 'failed' }), 409);
  assert.equal((await api.json(path + '/claim', post())).can_send, false);
});

test('restart preserves claimed and sent inquiries, replies and legacy table data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'shopping-rest-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'shopping.sqlite');
  const store = new Store(path);
  store.db.exec('CREATE TABLE IF NOT EXISTS legacy_migration_marker (value TEXT NOT NULL); INSERT INTO legacy_migration_marker VALUES (\'preserved\')');
  const api = await service(t, { store });
  const first = await submit(api);
  const second = await submit(api, 'second');
  const sent = await api.json('/api/operator/inquiries/claim', post());
  await api.json('/api/operator/inquiries/' + first.inquiry.id + '/send', post({ claim_token: sent.claim_token, outcome: 'sent' }));
  await api.json('/api/operator/inquiries/' + first.inquiry.id + '/replies', post({ merchant: 'supasonk', message_id: 'reply-before-restart', text: 'Available' }));
  const claimed = await api.json('/api/operator/inquiries/claim', post());
  assert.equal(claimed.inquiry.id, second.inquiry.id);
  await api.close();
  const reopened = await service(t, { store: new Store(path) });
  assert.equal(reopened.store.db.prepare('SELECT value FROM legacy_migration_marker').get().value, 'preserved');
  assert.equal((await reopened.json('/api/operator/inquiries/claim', post())).inquiry, null);
  const persisted = await reopened.json('/api/inquiries/' + first.inquiry.id);
  assert.equal(persisted.inquiry.status, 'sent');
  assert.equal(persisted.replies[0].text, 'Available');
  assert.equal((await reopened.json('/api/inquiries/' + second.inquiry.id)).inquiry.status, 'claimed');
  const result = await reopened.json('/api/operator/inquiries/' + second.inquiry.id + '/send', post({ claim_token: claimed.claim_token, outcome: 'needs_attention' }));
  assert.equal(result.inquiry.status, 'needs_attention');
  assert.equal((await reopened.json('/api/operator/inquiries/claim', post())).inquiry, null);
  await reopened.close();
});

test('product image paths cannot expose files outside the catalog, including symlinks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'shopping-rest-images-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogDirectory = join(directory, 'catalog');
  mkdirSync(catalogDirectory);
  const outside = join(directory, 'private.jpg');
  const secret = 'outside-catalog-private-content';
  writeFileSync(outside, secret);
  symlinkSync(outside, join(catalogDirectory, 'linked.jpg'));
  const original = loadProductDetails().products[0];
  const products = ['../private.jpg', outside, 'linked.jpg'].map((local_path, index) => ({
    ...original, product_id: 'unsafe-' + index, images: [{ ...original.images[0], local_path }],
  }));
  const catalogPath = join(catalogDirectory, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ capture_date: '2026-11-21', products }));
  const api = await service(t, { productDetails: loadProductDetails(catalogPath) });
  for (const product of products) {
    const response = await api.request('/api/products/' + product.product_id + '/pictures/1');
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes(secret), false);
  }
  await api.close();
});


test('REST and MCP share inquiry submissions and atomic claims in both directions', async t => {
  const api = await service(t);
  const buyer = new Client({ name: 'mixed-buyer-test', version: '1' });
  const operator = new Client({ name: 'mixed-operator-test', version: '1' });
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  try {
    await buyer.connect(new StreamableHTTPClientTransport(new URL(api.base + '/buyer/mcp'), {
      requestInit: { headers: { authorization: 'Bearer ' + api.buyerToken } },
    }));
    await operator.connect(new StreamableHTTPClientTransport(new URL(api.base + '/mcp'), {
      requestInit: { headers: { authorization: 'Bearer ' + api.token } },
    }));

    const firstInput = { request_id: randomUUID(), product_id: 'demo' };
    const fromMcp = await call(buyer, 'submit_product_inquiry', firstInput);
    assert.equal(fromMcp.created, true);
    const retriedViaRest = await api.json('/api/inquiries', post(firstInput, 'buyer'));
    assert.equal(retriedViaRest.created, false);
    assert.equal(retriedViaRest.inquiry.id, fromMcp.inquiry.id);
    const restClaim = await api.json('/api/operator/inquiries/claim', post());
    assert.equal(restClaim.inquiry.id, fromMcp.inquiry.id);
    assert.equal((await call(operator, 'claim_product_inquiry')).inquiry, null);
    const recordedViaMcp = await call(operator, 'record_product_inquiry_send', {
      inquiry_id: restClaim.inquiry.id, claim_token: restClaim.claim_token, outcome: 'sent',
    });
    assert.equal(recordedViaMcp.inquiry.status, 'sent');
    assert.equal((await api.json('/api/inquiries/' + restClaim.inquiry.id)).inquiry.status, 'sent');

    const secondInput = { request_id: randomUUID(), product_id: 'second' };
    const fromRest = await api.json('/api/inquiries', post(secondInput, 'buyer'), 201);
    const retriedViaMcp = await call(buyer, 'submit_product_inquiry', secondInput);
    assert.equal(retriedViaMcp.created, false);
    assert.equal(retriedViaMcp.inquiry.id, fromRest.inquiry.id);
    const mcpClaim = await call(operator, 'claim_product_inquiry');
    assert.equal(mcpClaim.inquiry.id, fromRest.inquiry.id);
    assert.equal((await api.json('/api/operator/inquiries/claim', post())).inquiry, null);
    const recordedViaRest = await api.json('/api/operator/inquiries/' + mcpClaim.inquiry.id + '/send', post({
      claim_token: mcpClaim.claim_token, outcome: 'needs_attention',
    }));
    assert.equal(recordedViaRest.inquiry.status, 'needs_attention');
    assert.equal((await call(buyer, 'get_product_inquiry', { inquiry_id: mcpClaim.inquiry.id })).inquiry.status, 'needs_attention');
  } finally {
    await Promise.all([buyer.close(), operator.close()]);
  }
});


test('a malformed absolute request URL returns 400 without disrupting the server', async t => {
  const api = await service(t);
  const response = await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(api.base).port) }, () => {
      socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    });
    let received = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Timed out waiting for malformed URL response')));
    socket.on('data', chunk => { received += chunk.toString(); });
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.equal((await api.request('/healthz', { role: null })).status, 200);
});
