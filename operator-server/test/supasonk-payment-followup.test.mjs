import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DEMO_NOTICE, FollowupStore, isAffirmativeAvailable } from '../scripts/supasonk-payment-followup.mjs';

const cli = fileURLToPath(new URL('../scripts/supasonk-payment-followup.mjs', import.meta.url));
const inbound = { sender: 'supasonk', message_id: 'instagram:test-message-1', message_timestamp: '2026-11-21 19:30 Asia/Bangkok', text: 'Yes, available!' };
function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'supasonk-followups-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'followups.sqlite');
}

test('only affirmative standalone available qualifies', () => {
  for (const value of ['available', 'AVAILABLE!', 'Yes, it is available.', 'This product is available now']) assert.equal(isAffirmativeAvailable(value), true, value);
  for (const value of ['unavailable', 'not available', 'Not currently available', 'No longer available', 'It isn’t available', 'available?', 'Is it available?', 'available but sold out', 'STOP available', 'availability', 'notavailable', 'available_item']) assert.equal(isAffirmativeAvailable(value), false, value);
});

test('persisted preparation authorizes only one send and refuses identity conflicts', t => {
  const path = database(t);
  let store = new FollowupStore(path);
  const first = store.prepare(inbound);
  assert.equal(first.can_send, true);
  assert.match(first.followup.message, /^ShopShop \| Payment Confirmation \(Demo\)\n\nDear Supason,/);
  assert.ok(first.followup.message.includes(DEMO_NOTICE));
  assert.ok(first.followup.message.includes(`Follow-up reference: ${first.followup.id}`));
  assert.match(first.followup.message, /@example\.com/);
  assert.match(first.followup.message, /not a deliverable address/);
  store.close();
  store = new FollowupStore(path);
  t.after(() => store.close());
  const again = store.prepare(inbound);
  assert.equal(again.can_send, false);
  assert.equal(again.followup.message, first.followup.message);
  assert.equal(again.followup.id, first.followup.id);
  assert.throws(() => store.prepare({ ...inbound, text: 'available now' }), /different content/);
  assert.throws(() => store.prepare({ ...inbound, message_timestamp: 'another date' }), /different content/);
  assert.equal(store.list().total, 1);
});

test('invalid recipient and negative reply never prepare a follow-up', t => {
  const store = new FollowupStore(database(t));
  t.after(() => store.close());
  assert.throws(() => store.prepare({ ...inbound, sender: 'someone_else' }), /Only inbound/);
  assert.throws(() => store.prepare({ ...inbound, message_id: '' }), /message_id/);
  assert.throws(() => store.prepare({ ...inbound, text: 'x'.repeat(2001) }), /text/);
  assert.throws(() => store.prepare({ ...inbound, extra: true }), /Invalid input/);
  assert.equal(store.prepare({ ...inbound, text: 'Not available' }).can_send, false);
  assert.equal(store.list().total, 0);
});

test('uncertain sends cannot retry but can recover with exact visible evidence', t => {
  const store = new FollowupStore(database(t));
  t.after(() => store.close());
  const { followup } = store.prepare(inbound);
  const uncertain = store.needsAttention({ followup_id: followup.id, evidence: 'Browser disconnected after pressing Send.' });
  assert.equal(uncertain.can_send, false);
  assert.equal(uncertain.followup.status, 'needs_attention');
  assert.equal(store.prepare(inbound).can_send, false);
  const verification = { followup_id: followup.id, visibly_verified: true, verified_message: followup.message, evidence: 'Exact outgoing reference and message observed in the supasonk chat.' };
  assert.throws(() => store.recordSent({ ...verification, visibly_verified: false }), /requires visibly_verified/);
  assert.throws(() => store.recordSent({ ...verification, verified_message: 'Different message' }), /exactly match/);
  const recovered = store.recordSent(verification);
  assert.equal(recovered.can_send, false);
  assert.equal(recovered.followup.status, 'sent');
  assert.equal(store.recordSent(verification).followup.status, 'sent');
  assert.throws(() => store.needsAttention({ followup_id: followup.id, evidence: 'Retry' }), /cannot be reset/);
  assert.equal(store.prepare(inbound).can_send, false);
});

test('new inbound identities get independently generated synthetic details', t => {
  const store = new FollowupStore(database(t));
  t.after(() => store.close());
  const first = store.prepare(inbound).followup;
  const second = store.prepare({ ...inbound, message_id: 'instagram:test-message-2' }).followup;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.message.match(/^Customer ID: (.+)$/m)[1], second.message.match(/^Customer ID: (.+)$/m)[1]);
  assert.notEqual(first.message.match(/^Email: (.+)$/m)[1], second.message.match(/^Email: (.+)$/m)[1]);
});

function runPrepare(path, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', cli, 'prepare', '--db', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(input));
  });
}

test('concurrent CLI preparations grant at most one send using JSON stdin', async t => {
  const path = database(t);
  const setup = new FollowupStore(path);
  setup.close();
  const input = { ...inbound, text: 'available — literal `$(demo_command)`' };
  const results = await Promise.all(Array.from({ length: 4 }, () => runPrepare(path, input)));
  assert.equal(results.filter(result => result.can_send).length, 1);
  assert.equal(new Set(results.map(result => result.followup.id)).size, 1);
  assert.equal(new Set(results.map(result => result.followup.message)).size, 1);
  const status = spawnSync(process.execPath, ['--no-warnings', cli, 'status', '--db', path], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).counts[0].count, 1);
});

test('CLI rejects malformed or excessive JSON with no send authorization', t => {
  const path = database(t);
  for (const input of ['{bad json', JSON.stringify({ ...inbound, text: 'a'.repeat(17000) })]) {
    const result = spawnSync(process.execPath, ['--no-warnings', cli, 'prepare', '--db', path], { input, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).can_send, false);
  }
});
