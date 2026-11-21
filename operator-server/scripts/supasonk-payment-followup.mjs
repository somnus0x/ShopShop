import { randomInt, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB = fileURLToPath(new URL('../.data/supasonk-payment-followups.sqlite', import.meta.url));
export const DEMO_NOTICE = 'Demo notice: This payment is simulated. All customer and delivery details are fictional. No actual payment or delivery has taken place.';
const fields = 'id, inbound_message_id, inbound_timestamp, inbound_text, message, status, created_at, completed_at, evidence';

function object(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    throw new Error('Invalid input fields; see help for the JSON shape.');
  }
}

function text(input, key, max) {
  if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input[key])) {
    throw new Error(`Invalid ${key}; provide nonempty text of at most ${max} characters.`);
  }
  return input[key].trim();
}

function id(input) {
  const value = text(input, 'followup_id', 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new Error('Invalid followup_id.');
  return value;
}

export function isAffirmativeAvailable(value) {
  const normalized = value.normalize('NFKC').replace(/[’‘]/g, "'");
  if (!/\bavailable\b/i.test(normalized)) return false;
  // Conservative: ambiguous questions, refusals, and negative replies need human inspection.
  return !/[?？]/.test(normalized) && !/\b(?:unavailable|not|no|never|isn't|aren't|wasn't|weren't|won't|can't|cannot|don't|doesn't|didn't|stop|cancel|sold\s+out|out\s+of\s+stock)\b/i.test(normalized);
}

function makeMessage(followupId) {
  const pick = options => options[randomInt(options.length)];
  const customerName = `Demo ${pick(['Mali', 'Nara', 'Pim', 'Krit', 'Arun', 'Nida'])} ${pick(['SAMPLE', 'TEST', 'EXAMPLE', 'FICTIONAL'])}`;
  const customerId = `DEMO-${randomUUID()}`;
  const email = `${customerId.toLowerCase()}@example.com`;
  const address = [
    `Plot ${randomInt(1, 10000)}, ${pick(['Example', 'Sample', 'Imaginary'])} Test Street`,
    'Demo District, Fictional City 00000',
    '(Fictional details; not a deliverable address.)',
  ].join('\n');
  const delivery = [
    `Method: ${pick(['Standard parcel', 'Express parcel', 'Scheduled courier'])}`,
    `Estimated delivery: ${pick(['Next demo business day', 'Within 2 demo business days', 'Within 3 demo business days'])}`,
    `Time window: ${pick(['09:00–12:00', '12:00–15:00', '15:00–18:00'])} (Asia/Bangkok)`,
    `Handoff: ${pick(['Demo reception', 'Demo doorstep', 'Demo collection desk'])}`,
  ].join('\n');
  return [
    'ShopShop | Payment Confirmation (Demo)',
    'Dear Supason,',
    'Thank you for confirming availability. The simulated payment has been completed for this demonstration. Please find the fictional customer and delivery details below.',
    `Customer Details\nName: ${customerName}\nCustomer ID: ${customerId}\nEmail: ${email}`,
    `Delivery Address (Fictional)\n${address}`,
    `Delivery Details (Simulated)\n${delivery}`,
    `Follow-up reference: ${followupId}`,
    DEMO_NOTICE,
    'Kind regards,\nShopShop',
  ].join('\n\n');
}

export class FollowupStore {
  constructor(path = DEFAULT_DB) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS followups (
        id TEXT PRIMARY KEY,
        inbound_message_id TEXT NOT NULL UNIQUE,
        inbound_timestamp TEXT NOT NULL,
        inbound_text TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'sent', 'needs_attention')),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        evidence TEXT
      );
    `);
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

  get(followupId) {
    return this.db.prepare(`SELECT ${fields} FROM followups WHERE id = ?`).get(followupId) ?? null;
  }

  prepare(input) {
    object(input, ['sender', 'message_id', 'message_timestamp', 'text']);
    if (input.sender !== 'supasonk') throw new Error('Only inbound messages from supasonk are supported.');
    const messageId = text(input, 'message_id', 400);
    const timestamp = text(input, 'message_timestamp', 160);
    const inboundText = text(input, 'text', 2000);
    if (!isAffirmativeAvailable(inboundText)) return { eligible: false, can_send: false, reason: 'No unambiguous affirmative standalone available keyword.' };
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT ${fields} FROM followups WHERE inbound_message_id = ?`).get(messageId);
      if (existing) {
        if (existing.inbound_timestamp !== timestamp || existing.inbound_text !== inboundText) throw new Error('This inbound identity was already recorded with different content or timestamp; inspect the conversation.');
        return {
          eligible: true, created: false, can_send: false, followup: existing,
          reason: 'Already prepared or completed. Inspect the saved message in Instagram; never send it again automatically. A visibly existing exact message can be recorded with record-sent.',
        };
      }
      const followupId = randomUUID();
      this.db.prepare('INSERT INTO followups (id, inbound_message_id, inbound_timestamp, inbound_text, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(followupId, messageId, timestamp, inboundText, makeMessage(followupId), 'prepared', new Date().toISOString());
      return { eligible: true, created: true, can_send: true, followup: this.get(followupId), instruction: 'Send the exact saved message once to supasonk using Computer Use, then visibly verify it before record-sent. For blocked or uncertain delivery use needs-attention.' };
    });
  }

  recordSent(input) {
    object(input, ['followup_id', 'visibly_verified', 'verified_message', 'evidence']);
    const followupId = id(input);
    const evidence = text(input, 'evidence', 2000);
    if (input.visibly_verified !== true || typeof input.verified_message !== 'string') throw new Error('record-sent requires visibly_verified:true and the exact verified_message observed in Instagram.');
    return this.transaction(() => {
      const row = this.get(followupId);
      if (!row) throw new Error('Follow-up not found.');
      if (input.verified_message !== row.message) throw new Error('The visibly verified message must exactly match the saved follow-up.');
      if (row.status !== 'sent') this.db.prepare("UPDATE followups SET status = 'sent', evidence = ?, completed_at = ? WHERE id = ?").run(evidence, new Date().toISOString(), followupId);
      return { can_send: false, followup: this.get(followupId) };
    });
  }

  needsAttention(input) {
    object(input, ['followup_id', 'evidence']);
    const followupId = id(input);
    const evidence = text(input, 'evidence', 2000);
    return this.transaction(() => {
      const row = this.get(followupId);
      if (!row) throw new Error('Follow-up not found.');
      if (row.status === 'sent') throw new Error('A verified sent follow-up cannot be reset.');
      this.db.prepare("UPDATE followups SET status = 'needs_attention', evidence = ?, completed_at = ? WHERE id = ?").run(evidence, new Date().toISOString(), followupId);
      return { can_send: false, followup: this.get(followupId), reason: 'Inspect Instagram; no automatic retry is authorized.' };
    });
  }

  status() {
    return { can_send: false, counts: this.db.prepare('SELECT status, count(*) AS count FROM followups GROUP BY status ORDER BY status').all(), note: 'Only the first successful prepare authorizes one send. Prepared and needs_attention rows never authorize an automatic retry.' };
  }

  list() {
    const followups = this.db.prepare(`SELECT ${fields} FROM followups ORDER BY rowid DESC LIMIT 100`).all();
    const total = this.db.prepare('SELECT count(*) AS count FROM followups').get().count;
    return { can_send: false, followups, total, truncated: total > followups.length };
  }

  close() { this.db.close(); }
}

const HELP = {
  usage: 'node scripts/supasonk-payment-followup.mjs <status|list|prepare|record-sent|needs-attention> [--db PATH]',
  default_database: DEFAULT_DB,
  input: 'For mutations, provide one JSON object on stdin using a JSON file or process stdin; do not interpolate Instagram text into shell commands. status/list need no input. This helper never accesses Instagram or sends a message.',
  prepare: { sender: 'supasonk', message_id: 'stable CUA-observed message identity', message_timestamp: 'stable date/time observed in Instagram', text: 'available' },
  'record-sent': { followup_id: 'UUID returned by prepare', visibly_verified: true, verified_message: 'Exact saved message visibly present in the correct Instagram conversation', evidence: 'Concise observed sender, recipient, timestamp, and outgoing message confirmation' },
  'needs-attention': { followup_id: 'UUID returned by prepare', evidence: 'Explain blocked or uncertain delivery' },
  identity: 'Use the same stable identity and timestamp for the same inbound message across runs. If Instagram exposes no stable ID in the UI, use a reproducible fingerprint of the observed conversation, full date/time, exact text, and neighboring message anchor. Never use the poll time or a fresh random ID. Inspect ambiguity rather than preparing.',
  recovery: 'Repeated prepare always returns can_send:false. If the exact saved message is visibly present, record-sent can recover prepared or needs_attention state. Otherwise stop for inspection; there is no reset or resend command.',
};

async function readInput() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error('JSON input exceeds 16 KiB.');
  }
  try { return JSON.parse(input); } catch { throw new Error('Expected one valid JSON object on stdin.'); }
}

async function main() {
  let store;
  try {
    const [command = 'help', ...args] = process.argv.slice(2);
    if (command === 'help' || command === '--help') { console.log(JSON.stringify(HELP, null, 2)); return; }
    if (!['status', 'list', 'prepare', 'record-sent', 'needs-attention'].includes(command)) throw new Error('Unknown command; use help.');
    if (args.length && (args.length !== 2 || args[0] !== '--db' || !args[1])) throw new Error('Only --db PATH is accepted after the command.');
    const input = ['prepare', 'record-sent', 'needs-attention'].includes(command) ? await readInput() : null;
    store = new FollowupStore(args[1] ?? DEFAULT_DB);
    const result = command === 'prepare' ? store.prepare(input) : command === 'record-sent' ? store.recordSent(input) : command === 'needs-attention' ? store.needsAttention(input) : store[command]();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, can_send: false }));
    process.exitCode = 1;
  } finally { store?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
