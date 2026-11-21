import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RECIPIENT } from './db.mjs';
import { callbackUrl, securePost, signedHeaders, validSecret, verifyCallback } from './webhooks.mjs';

export const EVENT_NAME = 'inquiry.created';
export const eventDefinition = {
  name: EVENT_NAME,
  description: 'A test inquiry was created for the authorized Instagram recipient supasonk.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object', properties: { recipient: { type: 'string', const: RECIPIENT } },
    required: ['recipient'], additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      inquiry_id: { type: 'string' },
      recipient: { type: 'string', const: RECIPIENT },
      kind: { type: 'string', const: 'test' },
    },
    required: ['inquiry_id', 'recipient', 'kind'], additionalProperties: false,
  },
};
export const subscriptionSchema = z.object({
  // Preserve the SDK's standard request metadata contract without persisting it.
  _meta: RequestSchema.shape.params.unwrap().shape._meta,
  name: z.literal(EVENT_NAME),
  arguments: z.object({ recipient: z.literal(RECIPIENT) }).strict(),
  delivery: z.object({
    mode: z.literal('webhook'), url: z.string().url(),
    secret: z.string().refine(validSecret, 'Expected a whsec_ secret containing 24–64 bytes'),
  }).strict(),
  cursor: z.null().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
}).strict();
export const unsubscribeSchema = z.object({
  _meta: RequestSchema.shape.params.unwrap().shape._meta,
  name: z.literal(EVENT_NAME),
  arguments: z.object({ recipient: z.literal(RECIPIENT) }).strict(),
  delivery: z.object({ mode: z.literal('webhook'), url: z.string().url() }).strict(),
}).strict();

export function subscriptionId(owner, params) {
  return 'sub_' + createHash('sha256').update(JSON.stringify([
    owner, params.delivery.url, params.name, params.arguments.recipient,
  ])).digest('hex').slice(0, 32);
}

export class EventService {
  constructor(store, { owner = 'local-owner', post = securePost } = {}) {
    this.store = store;
    this.owner = owner;
    this.post = post;
    this.running = false;
    this.verified = new Map();
  }
  async subscribe(input, onStage = () => {}) {
    onStage('validate_arguments');
    const params = subscriptionSchema.parse(input);
    onStage('validate_callback_url');
    callbackUrl(params.delivery.url);
    const subscription = {
      id: subscriptionId(this.owner, params), owner: this.owner,
      eventName: params.name, recipient: params.arguments.recipient,
      url: params.delivery.url, secret: params.delivery.secret,
      expiresAt: Date.now() + Math.min(params.ttlMs ?? 3_600_000, 86_400_000),
    };
    const verificationKey = createHash('sha256').update(subscription.id + subscription.secret).digest('hex');
    for (const [key, expires] of this.verified) if (expires <= Date.now()) this.verified.delete(key);
    if (!this.verified.has(verificationKey)) {
      onStage('verify_callback');
      await verifyCallback(subscription, this.post);
      if (this.verified.size >= 512) this.verified.delete(this.verified.keys().next().value);
      this.verified.set(verificationKey, Date.now() + 300_000);
    }
    onStage('persist_subscription');
    this.store.saveSubscription(subscription);
    return { id: subscription.id, refreshBefore: new Date(subscription.expiresAt).toISOString(), cursor: null, truncated: false };
  }
  unsubscribe(input, onStage = () => {}) {
    onStage('validate_arguments');
    const params = unsubscribeSchema.parse(input);
    onStage('persist_unsubscribe');
    this.store.unsubscribe(subscriptionId(this.owner, params), this.owner);
    return {};
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 10; i++) {
        const row = this.store.takeDueDelivery();
        if (!row) break;
        const subscription = { id: row.subscription_id, secret: row.signing_secret };
        try {
          const response = await this.post(row.callback_url, row.payload_json, signedHeaders(subscription, row.event_id, row.payload_json));
          const retryable = response.status >= 500 || [408, 429].includes(response.status);
          this.store.recordDelivery(row, response.status, retryable);
        } catch {
          // Never persist a callback URL, secret, response body, or raw network error.
          this.store.recordDelivery(row, null, true);
        }
      }
    } finally { this.running = false; }
  }
}
