import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

export class CallbackVerificationError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

export function validSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  const encoded = secret.slice(6);
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length >= 24 && bytes.length <= 64 && bytes.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, '');
}

export function publicAddress(address) {
  try {
    const ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) return publicAddress(ip.toIPv4Address().toString());
    if (ip.range() !== 'unicast') return false;
    if (ip.kind() === 'ipv4') {
      return !['192.0.0.0/24', '192.88.99.0/24'].some(cidr => ip.match(ipaddr.parseCIDR(cidr)));
    }
    return ip.match(ipaddr.parseCIDR('2000::/3')) &&
      !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(cidr => ip.match(ipaddr.parseCIDR(cidr)));
  } catch { return false; }
}

export function callbackUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Callback must be a public HTTPS URL on port 443 without credentials or a fragment');
  }
  return url;
}

// Resolve once per request, reject every non-public result, and pin the connection.
// HTTPS hostname verification is preserved; redirects are never followed.
export async function securePost(rawUrl, body, headers) {
  const url = callbackUrl(rawUrl);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Callback address is not public');
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      agent: false,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      lookup: (_hostname, options, done) => {
        const candidates = options.family ? addresses.filter(item => item.family === options.family) : addresses;
        if (!candidates.length) return done(new Error('No address in requested family'));
        if (options.all) done(null, candidates);
        else done(null, candidates[0].address, candidates[0].family);
      },
    }, response => {
      let received = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        received += chunk;
        if (Buffer.byteLength(received) > 262144) request.destroy(new Error('Callback response too large'));
      });
      response.on('end', () => resolve({ status: response.statusCode, body: received }));
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new CallbackVerificationError('timeout', 'Callback deadline exceeded')), 10_000);
    request.once('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body);
  });
}

export function signedHeaders(subscription, messageId, body, now = new Date()) {
  if (!validSecret(subscription.secret)) throw new Error('Invalid signing secret');
  return {
    'content-type': 'application/json',
    'webhook-id': messageId,
    'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
    'webhook-signature': new Webhook(subscription.secret).sign(messageId, now, body),
    'X-MCP-Subscription-Id': subscription.id,
  };
}

export async function verifyCallback(subscription, post = securePost) {
  const challenge = randomBytes(24).toString('base64url');
  const body = JSON.stringify({ type: 'verification', challenge });
  const id = 'verify_' + randomBytes(16).toString('hex');
  let response;
  try {
    response = await post(subscription.url, body, signedHeaders(subscription, id, body));
  } catch (error) {
    if (error instanceof CallbackVerificationError) throw error;
    const reason = ['ETIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'].includes(error?.code) ? 'timeout' : 'transport_error';
    // Never include raw network errors: they can contain callback URLs or credentials.
    throw new CallbackVerificationError(reason, 'Callback verification transport failed');
  }
  if (response.status < 200 || response.status >= 300) {
    const reason = response.status >= 500 ? 'http_5xx' : response.status >= 400 ? 'http_4xx' : 'http_error';
    throw new CallbackVerificationError(reason, 'Callback verification was rejected');
  }
  let reply;
  try { reply = JSON.parse(response.body); } catch { throw new CallbackVerificationError('challenge_failed', 'Invalid callback verification response'); }
  const expected = Buffer.from(challenge);
  const received = Buffer.from(typeof reply?.challenge === 'string' ? reply.challenge : '');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new CallbackVerificationError('challenge_failed', 'Callback challenge mismatch');
}
