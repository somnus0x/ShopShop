import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { Store } from '../src/db.mjs';
import { EventService } from '../src/events.mjs';
import { callbackUrl, publicAddress, securePost } from '../src/webhooks.mjs';
import { createMcpServer } from '../src/mcp.mjs';
import { loadProductDetails } from '../src/product-catalog.mjs';
import { startHttp } from '../src/server.mjs';

const secret = 'whsec_' + randomBytes(32).toString('base64');
const params = (url = 'https://receiver.example.com/callback') => ({
  name: 'inquiry.created', arguments: { recipient: 'supasonk' },
  delivery: { mode: 'webhook', url, secret }, cursor: null,
});
const unsignedParams = input => ({ name: input.name, arguments: input.arguments, delivery: { mode: 'webhook', url: input.delivery.url } });
function verifiedBody(body, headers) {
  return new Webhook(secret).verify(body, headers);
}
async function echo(_url, body, headers) {
  const message = verifiedBody(body, headers);
  return { status: 200, body: JSON.stringify({ challenge: message.challenge }) };
}
function memory(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

test('subscription verifies the signature and challenge before persistence; refresh is idempotent', async t => {
  const store = memory(t);
  let challenges = 0;
  const events = new EventService(store, { post: async (...args) => {
    challenges++;
    assert.equal(store.status().active_subscriptions, 0);
    return echo(...args);
  } });
  const first = await events.subscribe(params());
  const second = await events.subscribe(params());
  assert.equal(first.id, second.id);
  assert.equal(challenges, 1);
  assert.equal(store.status().active_subscriptions, 1);
  const bad = new EventService(store, { post: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
  await assert.rejects(bad.subscribe(params('https://receiver.example.com/bad')), /challenge mismatch/);
  assert.equal(store.status().active_subscriptions, 1);
});

test('only the authorized recipient and a valid signing key may subscribe', async t => {
  const store = memory(t);
  let calls = 0;
  const events = new EventService(store, { post: async () => { calls++; throw new Error('must not call'); } });
  await assert.rejects(events.subscribe({ ...params(), arguments: { recipient: 'someone_else' } }));
  await assert.rejects(events.subscribe({ ...params(), delivery: { ...params().delivery, secret: 'whsec_bad' } }));
  assert.equal(calls, 0);
  assert.equal(store.status().active_subscriptions, 0);
});

test('webhook destinations reject local, reserved, credentialed and non-HTTPS targets', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '192.0.2.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:8443', 'https://example.com/#fragment']) {
    assert.throws(() => callbackUrl(url));
  }
  await assert.rejects(securePost('https://127.0.0.1/callback', '{}', {}), /not public/);
});

test('duplicate triggers and claims cannot authorize a second DM', t => {
  const store = memory(t);
  assert.equal(store.createInquiry().created, true);
  assert.equal(store.createInquiry().created, false);
  const claim = store.claimInquiry('poc-supasonk-001');
  assert.equal(claim.can_send, true);
  assert.equal(store.claimInquiry('poc-supasonk-001').can_send, false);
  assert.throws(() => store.completeInquiry('poc-supasonk-001', 'wrong-token', 'sent', 'fake'), /Invalid claim/);
  store.completeInquiry('poc-supasonk-001', claim.claim_token, 'needs_attention', 'Send state uncertain; inspect the conversation.');
  assert.equal(store.claimInquiry('poc-supasonk-001').can_send, false);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM event_outbox').get().n, 1);
});

test('SQLite survives restart, while webhook retries preserve event identity and the claim', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'shopping-events-test-'));
  let store = new Store(join(dir, 'test.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const delivered = [];
  const post = async (url, body, headers) => {
    const event = verifiedBody(body, headers);
    if (event.type === 'verification') return echo(url, body, headers);
    assert.equal(headers['webhook-id'], event.eventId);
    delivered.push(event);
    return { status: delivered.length === 1 ? 503 : 202, body: '' };
  };
  let events = new EventService(store, { post });
  await events.subscribe(params());
  store.createInquiry();
  store.claimInquiry('poc-supasonk-001');
  await events.drain();
  assert.equal(store.status().deliveries[0].status, 'pending');
  store.close();
  store = new Store(join(dir, 'test.sqlite'));
  assert.equal(store.status().active_subscriptions, 1);
  assert.equal(store.claimInquiry('poc-supasonk-001').can_send, false);
  store.db.prepare('UPDATE deliveries SET next_attempt_at = 0').run();
  events = new EventService(store, { post });
  await events.drain();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].eventId, delivered[1].eventId);
  assert.equal(store.status().deliveries[0].status, 'delivered');
  assert.equal(store.getInquiry('poc-supasonk-001').status, 'claimed');
});

test('unsubscribe, expiry, and HTTP 410 stop future deliveries', async t => {
  const store = memory(t);
  let applications = 0;
  const events = new EventService(store, { post: async (url, body, headers) => {
    if (JSON.parse(body).type === 'verification') return echo(url, body, headers);
    applications++;
    return { status: 410, body: '' };
  } });
  const one = params('https://receiver.example.com/unsubscribe');
  await events.subscribe(one);
  store.createInquiry('unsubscribed');
  events.unsubscribe(unsignedParams(one));
  await events.drain();
  assert.equal(applications, 0);
  await events.subscribe(params('https://receiver.example.com/expired'));
  store.createInquiry('expired');
  store.db.prepare('UPDATE subscriptions SET expires_at = 0').run();
  await events.drain();
  assert.equal(applications, 0);
  await events.subscribe(params('https://receiver.example.com/gone'));
  store.createInquiry('gone');
  await events.drain();
  await events.drain();
  assert.equal(applications, 1);
  assert.equal(store.status().active_subscriptions, 0);
});

test('real MCP client discovers events and tools, subscribes, and receives no signing secret', async t => {
  const store = memory(t);
  const server = createMcpServer(store, new EventService(store, { post: echo }));
  const client = new Client({ name: 'poc-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const wireResponses = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => { wireResponses.push(message); return send(message, options); };
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // This SDK client's typed initialize parser drops the events extension.
  // Check the actual wire response, which the OpenAI event-aware host consumes.
  assert.ok(wireResponses.find(message => message.result?.serverInfo)?.result.capabilities.events);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 4);
  const events = await client.request({ method: 'events/list' }, z.object({ events: z.array(z.unknown()) }));
  assert.equal(events.events[0].name, 'inquiry.created');
  const sub = await client.request({ method: 'events/subscribe', params: params() }, z.object({ id: z.string() }));
  assert.match(sub.id, /^sub_/);
  const status = await client.callTool({ name: 'get_poc_status', arguments: {} });
  assert.equal(status.structuredContent.active_subscriptions, 1);
  assert.equal(JSON.stringify(status).includes(secret), false);
  const invalid = await client.callTool({ name: 'get_inquiry', arguments: { inquiry_id: '' } });
  assert.equal(invalid.isError, true);
});

test('real MCP event requests accept standard metadata without changing subscription identity', async t => {
  const store = memory(t);
  const diagnostics = [];
  const server = createMcpServer(store, new EventService(store, { post: echo }), {
    onEventDiagnostic: entry => diagnostics.push(entry),
  });
  const client = new Client({ name: 'metadata-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const input = params();
  const meta = { progressToken: 'private-progress-token', 'example.com/context': { value: 'private-metadata-value' } };
  const resultSchema = z.object({ id: z.string() });
  const first = await client.request({ method: 'events/subscribe', params: { ...input, _meta: meta } }, resultSchema);
  const refreshed = await client.request({ method: 'events/subscribe', params: { ...input, _meta: { progressToken: 42 } } }, resultSchema);
  assert.equal(first.id, refreshed.id);
  assert.equal(store.status().active_subscriptions, 1);
  await client.request({ method: 'events/unsubscribe', params: { ...unsignedParams(input), _meta: meta } }, z.object({}));
  assert.equal(store.status().active_subscriptions, 0);
  assert.ok(diagnostics.some(entry => entry.method === 'events/subscribe' && entry.stage === 'complete' && entry.status === 'success'));
  assert.ok(diagnostics.some(entry => entry.method === 'events/unsubscribe' && entry.stage === 'persist_unsubscribe' && entry.status === 'success'));
  const output = JSON.stringify(diagnostics);
  for (const value of [secret, input.delivery.url, 'private-progress-token', 'private-metadata-value']) assert.equal(output.includes(value), false);
});

test('event diagnostics identify validation and callback failures without exposing request data', async t => {
  const store = memory(t);
  const diagnostics = [];
  let failWithNetworkError = false;
  const server = createMcpServer(store, new EventService(store, { post: async (url) => {
    if (failWithNetworkError) throw new Error('private-network-error ' + url + ' ' + secret);
    return { status: 503, body: 'private-callback-response ' + secret };
  } }), { onEventDiagnostic: entry => diagnostics.push(entry) });
  const client = new Client({ name: 'diagnostic-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const input = params('https://receiver.example.com/private-callback-token');
  const invalid = { ...input, arguments: { recipient: 'private-invalid-recipient' }, 'private-field-name': secret };
  await assert.rejects(client.request({ method: 'events/subscribe', params: invalid }, z.object({})), error => error.code === -32602);
  const validateFailure = diagnostics.find(entry => entry.stage === 'validate_arguments' && entry.status === 'failure');
  assert.ok(validateFailure.issues.some(issue => issue.path.join('.') === 'arguments.recipient'));
  assert.ok(validateFailure.issues.every(issue => Object.keys(issue).sort().join(',') === 'code,path'));
  await assert.rejects(client.request({ method: 'events/subscribe', params: input }, z.object({})), error => error.code === -32015 && error.data.reason === 'http_5xx');
  failWithNetworkError = true;
  await assert.rejects(client.request({ method: 'events/subscribe', params: input }, z.object({})), error => error.code === -32015 && error.data.reason === 'transport_error');
  assert.ok(diagnostics.some(entry => entry.stage === 'verify_callback' && entry.status === 'failure' && entry.reason === 'http_5xx'));
  assert.ok(diagnostics.some(entry => entry.stage === 'verify_callback' && entry.status === 'failure' && entry.reason === 'transport_error'));
  assert.equal(store.status().active_subscriptions, 0);
  const output = JSON.stringify(diagnostics);
  for (const value of [secret, input.delivery.url, 'private-invalid-recipient', 'private-field-name', 'private-network-error', 'private-callback-response']) {
    assert.equal(output.includes(value), false);
  }
});

test('local HTTP transport requires a bearer token and rejects browser origins', async t => {
  const store = memory(t);
  const token = randomBytes(32).toString('base64url');
  const listener = await startHttp({ store, events: new EventService(store, { post: echo }), token, port: 0 });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = 'http://127.0.0.1:' + listener.address().port + '/mcp';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://example.com', authorization: 'Bearer ' + token } })).status, 403);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } } }),
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).result.capabilities.events);
});

test('buyer and operator MCP roles carry a product click through to a merchant reply', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { ProductInquiries } = await import('../src/product-inquiries.mjs');
  const { randomUUID } = await import('node:crypto');
  const store = memory(t);
  const flow = new ProductInquiries(store, new Map([['demo', { name: 'Demo product', merchant: 'supasonk' }]]));
  const token = randomBytes(32).toString('base64url');
  const buyerToken = randomBytes(32).toString('base64url');
  const server = await startHttp({ store, events: new EventService(store), productInquiries: flow, productDetails: loadProductDetails(), token, buyerToken, port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + buyerToken } })).status, 401);
  const connect = async (path, key) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + path), { requestInit: { headers: { authorization: 'Bearer ' + key } } }));
    t.after(() => client.close());
    return client;
  };
  const buyer = await connect('/buyer/mcp', buyerToken);
  const operator = await connect('/mcp', token);
  assert.deepEqual((await buyer.listTools()).tools.map(tool => tool.name), ['submit_product_inquiry', 'get_product_inquiry', 'list_products', 'get_product']);
  const call = (client, name, args) => client.callTool({ name, arguments: args });
  const matches = (await call(buyer, 'list_products', { query: 'loadlite', merchant: '@Overhills.th' })).structuredContent;
  assert.equal(matches.total, 1);
  const { product_id } = matches.products[0];
  const result = await call(buyer, 'get_product', { product_id });
  assert.equal(result.structuredContent.product.product_id, product_id);
  assert.equal(result.structuredContent.product.price, 1090);
  assert.equal(result.structuredContent.picture_index, 1);
  const picture = result.content.find(block => block.type === 'image');
  assert.equal(picture.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(picture.data, 'base64').readUInt16BE(0), 0xffd8);
  const alternate = await call(operator, 'get_product', { product_id, picture_index: 2 });
  assert.equal(alternate.structuredContent.picture_index, 2);
  assert.notEqual(alternate.content.find(block => block.type === 'image').data, picture.data);
  assert.equal((await call(buyer, 'get_product', { product_id, picture_index: 99 })).isError, true);
  assert.equal((await call(buyer, 'get_product', { product_id: 'missing' })).isError, true);
  const input = { request_id: randomUUID(), product_id: 'demo' };
  const queued = (await call(buyer, 'submit_product_inquiry', input)).structuredContent;
  assert.equal(queued.created, true);
  assert.equal((await call(buyer, 'submit_product_inquiry', input)).structuredContent.inquiry.id, queued.inquiry.id);
  assert.equal((await call(buyer, 'claim_product_inquiry', {})).isError, true);
  const claim = (await call(operator, 'claim_product_inquiry', {})).structuredContent;
  assert.equal(claim.inquiry.merchant, 'supasonk');
  assert.equal((await call(operator, 'claim_product_inquiry', {})).structuredContent.inquiry, null);
  const inquiry_id = queued.inquiry.id;
  assert.equal((await call(operator, 'record_product_inquiry_send', { inquiry_id, claim_token: claim.claim_token, outcome: 'sent' })).structuredContent.inquiry.status, 'sent');
  const reply = { inquiry_id, merchant: 'supasonk', message_id: 'reply-1', text: 'Available', qr_image_url: 'https://example.com/sample-qr.png' };
  assert.equal((await call(operator, 'record_product_merchant_reply', { ...reply, merchant: 'wrong' })).isError, true);
  assert.equal((await call(operator, 'record_product_merchant_reply', reply)).structuredContent.recorded, true);
  assert.equal((await call(operator, 'record_product_merchant_reply', reply)).structuredContent.recorded, false);
  const view = (await call(buyer, 'get_product_inquiry', { inquiry_id })).structuredContent;
  assert.equal(view.inquiry.claim_token, undefined);
  assert.equal(view.replies.length, 1);
  assert.equal(view.replies[0].qr_image_url, reply.qr_image_url);
});
