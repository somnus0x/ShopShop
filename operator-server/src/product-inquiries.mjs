import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { defineTool as tool, toolResult } from './mcp-tool.mjs';
import { merchantHandle, productCatalogTools, productId } from './product-catalog.mjs';

const inquiryId = z.string().uuid();
const catalogEntry = z.object({
  product_id: productId,
  name: z.string().trim().min(1).max(200),
  merchant: merchantHandle,
}).strict();
const text = z.string().trim().min(1).max(2000);
const imageUrl = z.string().max(4096).url().refine(value => {
  const url = new URL(value);
  return /^https:\/\//i.test(value) && !url.username && !url.password;
}, 'Use an HTTPS image URL without embedded credentials');

// Shared validation for the existing MCP tools and the REST API.
export const productInquirySchemas = {
  submit: z.strictObject({ request_id: z.string().uuid(), product_id: productId }),
  get: z.strictObject({ inquiry_id: inquiryId }),
  send: z.strictObject({ inquiry_id: inquiryId, claim_token: inquiryId, outcome: z.enum(['sent', 'needs_attention']) }),
  reply: z.strictObject({
    inquiry_id: inquiryId, merchant: catalogEntry.shape.merchant, message_id: z.string().min(1).max(200), text: text.optional(), qr_image_url: imageUrl.optional(),
  }).refine(input => input.text || input.qr_image_url, 'Reply must contain text or an image'),
};

function inquiryMessage(inquiry) {
  if (inquiry.product_id === 'demo-supasonk' && inquiry.merchant === 'supasonk') {
    return [
      'Hi Supason, I’m reaching out on behalf of ShopShop, a shopping assistant. We’re testing an inquiry for the ' + inquiry.product_name + '. Could you reply “available” and, if you’re happy to help, send a sample QR image with no payment details? There’s no real order or payment for this test.',
      'Demo reference: ' + inquiry.id,
      'About: https://shopshop.example/about\nPrivacy: https://shopshop.example/privacy\nOpt out: https://shopshop.example/opt-out',
      'These are demo links and don’t open a live site. If you’d prefer no further test messages, reply STOP. Thanks for helping us test ShopShop.',
    ].join('\n\n');
  }
  return 'Hi! Is ' + inquiry.product_name + ' available, and what is the price? Reference: ' + inquiry.id + '.';
}

export function loadCatalog(path) {
  if (!path) return new Map();
  const entries = z.array(catalogEntry).parse(JSON.parse(readFileSync(path, 'utf8')));
  const catalog = new Map(entries.map(entry => [entry.product_id, entry]));
  if (catalog.size !== entries.length) throw new Error('Duplicate product ID in inquiry catalog');
  return catalog;
}

const publicFields = 'id, product_id, product_name, status, created_at';

export class ProductInquiries {
  constructor(store, catalog) {
    this.store = store;
    this.catalog = catalog;
  }

  submit({ request_id, product_id }) {
    const { db } = this.store;
    return this.store.transaction(() => {
      const existing = db.prepare('SELECT ' + publicFields + ' FROM product_inquiries WHERE request_id = ?').get(request_id);
      if (existing) {
        if (existing.product_id !== product_id) throw new Error('Request ID already used for a different product');
        return { created: false, inquiry: existing };
      }
      const product = this.catalog.get(product_id);
      if (!product) throw new Error('Unknown product ID');
      const id = randomUUID();
      db.prepare('INSERT INTO product_inquiries (id, request_id, product_id, product_name, merchant, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, request_id, product_id, product.name, product.merchant.toLowerCase(), new Date().toISOString());
      return { created: true, inquiry: this.get(id).inquiry };
    });
  }

  get(id) {
    const { db } = this.store;
    const inquiry = db.prepare('SELECT ' + publicFields + ' FROM product_inquiries WHERE id = ?').get(id);
    if (!inquiry) throw new Error('Product inquiry not found');
    const replies = db.prepare('SELECT text, qr_image_url, received_at FROM merchant_replies WHERE inquiry_id = ? ORDER BY rowid').all(id);
    return { inquiry, replies };
  }

  list({ status, offset = 0, limit = 20 } = {}) {
    const where = status ? ' WHERE status = ?' : '';
    const args = status ? [status] : [];
    const total = this.store.db.prepare('SELECT count(*) AS count FROM product_inquiries' + where).get(...args).count;
    const inquiries = this.store.db.prepare('SELECT ' + publicFields + ', merchant FROM product_inquiries' + where + ' ORDER BY rowid LIMIT ? OFFSET ?')
      .all(...args, limit, offset).map(inquiry => ({ ...inquiry, message: inquiryMessage(inquiry) }));
    return { inquiries, total, next_offset: offset + limit < total ? offset + limit : null };
  }

  claim() {
    const { db } = this.store;
    return this.store.transaction(() => {
      const inquiry = db.prepare("SELECT id, product_id, product_name, merchant FROM product_inquiries WHERE status = 'queued' ORDER BY rowid LIMIT 1").get();
      if (!inquiry) return { inquiry: null };
      const claimToken = randomUUID();
      db.prepare("UPDATE product_inquiries SET status = 'claimed', claim_token = ? WHERE id = ?").run(claimToken, inquiry.id);
      return {
        inquiry,
        claim_token: claimToken,
        message: inquiryMessage(inquiry),
      };
    });
  }

  recordSend({ inquiry_id, claim_token, outcome }) {
    const { db } = this.store;
    return this.store.transaction(() => {
      const row = db.prepare('SELECT status FROM product_inquiries WHERE id = ? AND claim_token = ?').get(inquiry_id, claim_token);
      if (!row || (row.status !== 'claimed' && row.status !== outcome)) throw new Error('Invalid claim or conflicting outcome');
      if (row.status === 'claimed') db.prepare('UPDATE product_inquiries SET status = ? WHERE id = ?').run(outcome, inquiry_id);
      return { inquiry: this.get(inquiry_id).inquiry };
    });
  }

  recordReply({ inquiry_id, merchant, message_id, text, qr_image_url }) {
    const { db } = this.store;
    return this.store.transaction(() => {
      const row = db.prepare('SELECT status, merchant FROM product_inquiries WHERE id = ?').get(inquiry_id);
      if (row?.status !== 'sent' || row.merchant !== merchant.toLowerCase()) throw new Error('Reply does not match a sent inquiry and merchant');
      const existing = db.prepare('SELECT text, qr_image_url FROM merchant_replies WHERE inquiry_id = ? AND message_id = ?').get(inquiry_id, message_id);
      if (existing) {
        if (existing.text !== (text ?? null) || existing.qr_image_url !== (qr_image_url ?? null)) throw new Error('Conflicting duplicate merchant reply');
        return { recorded: false };
      }
      db.prepare('INSERT INTO merchant_replies VALUES (?, ?, ?, ?, ?)').run(inquiry_id, message_id, text ?? null, qr_image_url ?? null, new Date().toISOString());
      return { recorded: true };
    });
  }
}

export function productTools(flow, role) {
  if (role === 'buyer') return [
    tool('submit_product_inquiry', 'Queue an inquiry for a configured product. Reuse a unique request ID when retrying the same click.', productInquirySchemas.submit, input => toolResult(flow.submit(input))),
    tool('get_product_inquiry', 'Read the status, merchant reply text and QR image URL for an inquiry using its private ID.', productInquirySchemas.get, input => toolResult(flow.get(input.inquiry_id)), true),
  ];
  return [
    tool('claim_product_inquiry', 'Reserve the next product inquiry for one merchant send. Only claim when ready to send.', z.strictObject({}), () => toolResult(flow.claim())),
    tool('record_product_inquiry_send', 'Record a confirmed send or an uncertain outcome for a claimed inquiry.', productInquirySchemas.send, input => toolResult(flow.recordSend(input))),
    tool('record_product_merchant_reply', 'Record a verified merchant reply for a specific sent inquiry. Attach a QR image URL only when it belongs to that inquiry.', productInquirySchemas.reply, input => toolResult(flow.recordReply(input))),
  ];
}

export function registerProductBuyerHandlers(server, flow, productDetails) {
  const tools = [...productTools(flow, 'buyer'), ...productCatalogTools(productDetails)];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => tool.definition) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const tool = tools.find(candidate => candidate.definition.name === request.params.name);
      if (!tool) throw new Error('Unknown tool');
      return tool.invoke(request.params.arguments ?? {});
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof z.ZodError ? 'Invalid tool arguments' : error.message }] };
    }
  });
}
