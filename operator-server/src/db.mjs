import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RECIPIENT = 'supasonk';
export const TEST_MESSAGE = [
  'ShopShop | Test Inquiry',
  'Dear Supason,',
  'This is a test message from ShopShop, an AI-assisted shopping assistant, sent with permission from this account’s owner.',
  'Please reply “test received” to confirm receipt. This is a demonstration only; no purchase or payment is involved.',
  'Thank you for your assistance.\n\nKind regards,\nShopShop',
].join('\n\n');
export const DEFAULT_DB = resolve(process.env.POC_DATA_DIR || '.data', 'shopping-poc.sqlite');

export class Store {
  constructor(path = DEFAULT_DB) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    if (path !== ':memory:') chmodSync(path, 0o600);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getInquiry(id) {
    return this.db.prepare('SELECT id, recipient, message, status, created_at, claimed_at, completed_at, evidence FROM inquiries WHERE id = ?').get(id) ?? null;
  }

  createInquiry(id = 'poc-supasonk-001') {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid inquiry ID');
    return this.transaction(() => {
      const existing = this.getInquiry(id);
      if (existing) return { created: false, inquiry: existing };
      const now = new Date().toISOString();
      const event = {
        eventId: 'evt_' + randomUUID(),
        name: 'inquiry.created',
        timestamp: now,
        data: { inquiry_id: id, recipient: RECIPIENT, kind: 'test' },
        cursor: null,
      };
      this.db.prepare('INSERT INTO inquiries (id, recipient, message, created_at) VALUES (?, ?, ?, ?)').run(id, RECIPIENT, TEST_MESSAGE, now);
      this.db.prepare('INSERT INTO event_outbox VALUES (?, ?, ?, ?)').run(event.eventId, id, JSON.stringify(event), now);
      this.db.prepare("INSERT INTO deliveries (event_id, subscription_id, next_attempt_at) SELECT ?, id, ? FROM subscriptions WHERE active = 1 AND expires_at > ? AND recipient = ?")
        .run(event.eventId, Date.now(), Date.now(), RECIPIENT);
      return { created: true, event_id: event.eventId, inquiry: this.getInquiry(id) };
    });
  }

  claimInquiry(id) {
    return this.transaction(() => {
      const inquiry = this.getInquiry(id);
      if (!inquiry) throw new Error('Inquiry not found');
      if (inquiry.status !== 'pending') {
        return { can_send: false, inquiry, reason: 'This inquiry has already been claimed or completed. Inspect the existing conversation; do not resend automatically.' };
      }
      const claimToken = randomUUID();
      this.db.prepare("UPDATE inquiries SET status = 'claimed', claim_token = ?, claimed_at = ? WHERE id = ? AND status = 'pending'")
        .run(claimToken, new Date().toISOString(), id);
      return { can_send: true, claim_token: claimToken, inquiry: this.getInquiry(id) };
    });
  }

  completeInquiry(id, claimToken, status, evidence) {
    if (!['sent', 'failed', 'needs_attention'].includes(status)) throw new Error('Invalid outcome');
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000) throw new Error('Evidence is required (up to 2000 characters)');
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id);
      if (!current || current.claim_token !== claimToken) throw new Error('Invalid claim');
      if (current.status === status && current.evidence === evidence) return this.getInquiry(id);
      if (current.status !== 'claimed') throw new Error('Inquiry is already completed');
      this.db.prepare('UPDATE inquiries SET status = ?, evidence = ?, completed_at = ? WHERE id = ?')
        .run(status, evidence, new Date().toISOString(), id);
      return this.getInquiry(id);
    });
  }

  saveSubscription(subscription) {
    const s = subscription;
    this.db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET signing_secret = excluded.signing_secret, expires_at = excluded.expires_at, active = 1')
      .run(s.id, s.owner, s.eventName, s.recipient, s.url, s.secret, s.expiresAt);
  }

  unsubscribe(id, owner) {
    this.transaction(() => {
      this.db.prepare('UPDATE subscriptions SET active = 0 WHERE id = ? AND owner = ?').run(id, owner);
      this.db.prepare("UPDATE deliveries SET status = 'cancelled' WHERE subscription_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND owner = ? AND active = 0)").run(id, id, owner);
    });
  }

  takeDueDelivery(now = Date.now()) {
    return this.transaction(() => {
      this.db.prepare("UPDATE deliveries SET status = 'cancelled', error_code = 'subscription_inactive' WHERE status = 'pending' AND subscription_id IN (SELECT id FROM subscriptions WHERE active = 0 OR expires_at <= ?)").run(now);
      const row = this.db.prepare("SELECT d.*, e.payload_json, s.callback_url, s.signing_secret, s.owner FROM deliveries d JOIN event_outbox e ON e.event_id = d.event_id JOIN subscriptions s ON s.id = d.subscription_id WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND s.active = 1 AND s.expires_at > ? ORDER BY d.next_attempt_at LIMIT 1").get(now, now);
      if (!row) return null;
      // A short lease prevents simultaneous workers from normally posting the same event.
      this.db.prepare('UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ? AND subscription_id = ?').run(now + 30_000, row.event_id, row.subscription_id);
      return { ...row, attempts: row.attempts + 1 };
    });
  }

  recordDelivery(row, httpStatus, retryable, now = Date.now()) {
    const ok = httpStatus >= 200 && httpStatus < 300;
    const status = ok ? 'delivered' : retryable && row.attempts < 5 ? 'pending' : 'failed';
    const error = ok ? null : httpStatus ? 'http_' + httpStatus : 'transport_error';
    this.db.prepare('UPDATE deliveries SET status = ?, next_attempt_at = ?, last_http_status = ?, error_code = ?, delivered_at = ? WHERE event_id = ? AND subscription_id = ?')
      .run(status, now + Math.min(60_000, 1000 * 2 ** row.attempts), httpStatus, error, ok ? new Date(now).toISOString() : null, row.event_id, row.subscription_id);
    if (httpStatus === 410) this.unsubscribe(row.subscription_id, row.owner);
  }

  status() {
    const active = this.db.prepare('SELECT count(*) AS n FROM subscriptions WHERE active = 1 AND expires_at > ?').get(Date.now()).n;
    return {
      active_subscriptions: active,
      inquiries: this.db.prepare('SELECT status, count(*) AS count FROM inquiries GROUP BY status').all(),
      deliveries: this.db.prepare('SELECT status, count(*) AS count FROM deliveries GROUP BY status').all(),
      note: 'Webhook delivery is not proof that a DM was sent. Inquiry outcomes are reported by the executing agent.',
    };
  }

  close() { this.db.close(); }
}
