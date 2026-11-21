import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getProductJson, getProductPicture, listProducts, productId } from './product-catalog.mjs';
import { productInquirySchemas } from './product-inquiries.mjs';

const maxBodyBytes = 16 * 1024;
const empty = z.strictObject({});
const integerQuery = (min, max) => z.string().regex(/^\d+$/).pipe(z.coerce.number().int().min(min).max(max));
const pagination = {
  offset: integerQuery(0, Number.MAX_SAFE_INTEGER - 50).optional(),
  limit: integerQuery(1, 50).optional(),
};
const productQuery = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  merchant: z.string().regex(/^@?[a-zA-Z0-9._]{1,30}$/).optional(),
  ...pagination,
});
const queueQuery = z.strictObject({
  status: z.enum(['queued', 'claimed', 'sent', 'needs_attention']).optional(), ...pagination,
});
const testResult = z.strictObject({
  claim_token: z.string().uuid(), outcome: z.enum(['sent', 'failed', 'needs_attention']),
  evidence: z.string().trim().min(1).max(2000),
});

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function authorized(header, token) {
  if (!token) return false;
  const expected = Buffer.from('Bearer ' + token);
  const provided = Buffer.from(header || '');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function readBody(request) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json');
  if (Number(request.headers['content-length']) > maxBodyBytes) throw new HttpError(413, 'payload_too_large', 'JSON body exceeds 16 KiB');
  return new Promise((resolve, reject) => {
    let size = 0, failed = false;
    const chunks = [];
    request.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, 'payload_too_large', 'JSON body exceeds 16 KiB'));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      if (!size) { resolve({}); return; }
      if (!contentType) { reject(new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid_json', 'Request body must be valid JSON')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new HttpError(400, 'invalid_request', 'Request was interrupted')));
  });
}

const missing = new Set(['Unknown product ID', 'Product inquiry not found', 'Product not found', 'Picture index out of range', 'Product picture unavailable', 'Inquiry not found']);
const conflicts = new Set(['Request ID already used for a different product', 'Invalid claim or conflicting outcome', 'Reply does not match a sent inquiry and merchant', 'Conflicting duplicate merchant reply', 'Invalid claim', 'Inquiry is already completed']);

function errorResponse(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof z.ZodError || error instanceof URIError) return new HttpError(400, 'invalid_request', 'Invalid request parameters');
  if (missing.has(error.message)) return new HttpError(404, 'not_found', error.message);
  if (conflicts.has(error.message)) return new HttpError(409, 'conflict', error.message);
  return new HttpError(500, 'internal_error', 'Internal server error');
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// REST is an additional transport over the same catalog and atomic queue used by MCP.
export function createRestHandler({ store, token, buyerToken, productInquiries, productDetails, buyerOnly = false, publicBuyerRest = false, allowedOrigins = [] }) {
  const origins = new Set(allowedOrigins);
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('POC_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
  }
  const routes = [];
  const route = (method, path, role, run) => routes.push({ method, path, role, run });
  const result = (body, status = 200) => ({ body, status });

  if (productDetails) {
    route('GET', /^\/api\/products$/, 'buyer', ({ query }) => result(listProducts(productDetails, productQuery.parse(query))));
    route('GET', /^\/api\/products\/([^/]+)$/, 'buyer', ({ parts, query }) => {
      empty.parse(query);
      return result(getProductJson(productDetails, productId.parse(parts[0])));
    });
    route('GET', /^\/api\/products\/([^/]+)\/pictures\/([^/]+)$/, 'buyer', ({ parts, query }) => {
      empty.parse(query);
      const picture = getProductPicture(productDetails, productId.parse(parts[0]), integerQuery(1, Number.MAX_SAFE_INTEGER).parse(parts[1]));
      return { body: picture.data, type: picture.mimeType, status: 200 };
    });
  }
  if (productInquiries) {
    route('POST', /^\/api\/inquiries$/, 'buyer', ({ body, query }) => {
      empty.parse(query);
      const submitted = productInquiries.submit(productInquirySchemas.submit.parse(body));
      return result(submitted, submitted.created ? 201 : 200);
    });
    route('GET', /^\/api\/inquiries\/([^/]+)$/, 'buyer', ({ parts, query }) => {
      empty.parse(query);
      return result(productInquiries.get(z.string().uuid().parse(parts[0])));
    });
    if (!buyerOnly) {
      route('GET', /^\/api\/operator\/inquiries$/, 'operator', ({ query }) => result(productInquiries.list(queueQuery.parse(query))));
      route('POST', /^\/api\/operator\/inquiries\/claim$/, 'operator', ({ body, query }) => {
        empty.parse(body); empty.parse(query);
        return result(productInquiries.claim());
      });
      route('POST', /^\/api\/operator\/inquiries\/([^/]+)\/send$/, 'operator', ({ parts, body, query }) => {
        empty.parse(query);
        const input = productInquirySchemas.send.omit({ inquiry_id: true }).parse(body);
        return result(productInquiries.recordSend({ ...input, inquiry_id: z.string().uuid().parse(parts[0]) }));
      });
      route('POST', /^\/api\/operator\/inquiries\/([^/]+)\/replies$/, 'operator', ({ parts, body, query }) => {
        empty.parse(query);
        // The path supplies inquiry_id; reject an extra ID in the JSON body.
        if (body && Object.hasOwn(body, 'inquiry_id')) throw new HttpError(400, 'invalid_request', 'Supply the inquiry ID in the URL');
        const input = productInquirySchemas.reply.parse({ ...body, inquiry_id: parts[0] });
        return result(productInquiries.recordReply(input));
      });
    }
  }
  if (!buyerOnly) {
    route('GET', /^\/api\/operator\/status$/, 'operator', ({ query }) => {
      empty.parse(query);
      return result({ ...store.status(), product_inquiries: store.db.prepare('SELECT status, count(*) AS count FROM product_inquiries GROUP BY status').all() });
    });
    route('POST', /^\/api\/operator\/test-inquiries$/, 'operator', ({ body, query }) => {
      empty.parse(body); empty.parse(query);
      const submitted = store.createInquiry();
      return result(submitted, submitted.created ? 201 : 200);
    });
    route('GET', /^\/api\/operator\/test-inquiries\/([^/]+)$/, 'operator', ({ parts, query }) => {
      empty.parse(query);
      const inquiry = store.getInquiry(productId.parse(parts[0]));
      if (!inquiry) throw new Error('Inquiry not found');
      return result({ inquiry });
    });
    route('POST', /^\/api\/operator\/test-inquiries\/([^/]+)\/claim$/, 'operator', ({ parts, body, query }) => {
      empty.parse(body); empty.parse(query);
      return result(store.claimInquiry(productId.parse(parts[0])));
    });
    route('POST', /^\/api\/operator\/test-inquiries\/([^/]+)\/result$/, 'operator', ({ parts, body, query }) => {
      empty.parse(query);
      const { claim_token, outcome, evidence } = testResult.parse(body);
      return result({ inquiry: store.completeInquiry(productId.parse(parts[0]), claim_token, outcome, evidence) });
    });
  }

  return async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { json(response, 400, { error: { code: 'invalid_request', message: 'Invalid request URL' } }); return true; }
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return false;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      const matches = routes.filter(candidate => candidate.path.test(url.pathname));
      if (!matches.length) throw new HttpError(404, 'not_found', 'Endpoint not found');
      const origin = request.headers.origin;
      if (origin) {
        response.setHeader('vary', 'Origin');
        if (matches[0].role !== 'buyer' || !origins.has(origin)) throw new HttpError(403, 'origin_not_allowed', 'Origin not allowed');
        response.setHeader('access-control-allow-origin', origin);
      }
      const methods = matches.map(candidate => candidate.method);
      if (request.method === 'OPTIONS' && origin) {
        const requestedHeaders = (request.headers['access-control-request-headers'] || '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
        if (!methods.includes(request.headers['access-control-request-method']) || requestedHeaders.some(header => !['authorization', 'content-type'].includes(header))) {
          throw new HttpError(403, 'preflight_not_allowed', 'CORS request not allowed');
        }
        response.writeHead(204, { 'access-control-allow-methods': methods.join(', '), 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600' }).end();
        return true;
      }
      const role = matches[0].role;
      const anonymousBuyer = publicBuyerRest && role === 'buyer';
      if (!(anonymousBuyer || (!buyerOnly && authorized(request.headers.authorization, token)) || (role === 'buyer' && authorized(request.headers.authorization, buyerToken)))) {
        response.setHeader('www-authenticate', 'Bearer');
        throw new HttpError(401, 'unauthorized', 'Valid bearer token required');
      }
      const selected = matches.find(candidate => candidate.method === request.method);
      if (!selected) {
        response.setHeader('allow', methods.join(', '));
        throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      }
      const query = {};
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key)) throw new HttpError(400, 'invalid_request', 'Duplicate query parameter');
        Object.defineProperty(query, key, { value, enumerable: true });
      }
      const parts = selected.path.exec(url.pathname).slice(1).map(part => decodeURIComponent(part));
      const body = request.method === 'POST' ? await readBody(request) : undefined;
      const output = selected.run({ parts, query, body });
      if (output.type) response.writeHead(output.status, { 'content-type': output.type, 'content-length': output.body.length }).end(output.body);
      else json(response, output.status, output.body);
    } catch (error) {
      request.resume();
      const failure = errorResponse(error);
      json(response, failure.status, { error: { code: failure.code, message: failure.message } });
    }
    return true;
  };
}
