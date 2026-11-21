import { Store, DEFAULT_DB } from '../src/db.mjs';
const store = new Store();
try {
  const command = process.argv[2] || 'status';
  if (command === 'status') console.log(JSON.stringify({ database: DEFAULT_DB, ...store.status() }, null, 2));
  else if (command === 'trigger') {
    if (!store.status().active_subscriptions) throw new Error('No active OpenAI event subscription. Connect the plugin and subscribe in Work Cloud before triggering.');
    console.log(JSON.stringify(store.createInquiry('poc-supasonk-001'), null, 2));
  } else if (command === 'inquiry') console.log(JSON.stringify(store.getInquiry('poc-supasonk-001'), null, 2));
  else throw new Error('Usage: npm run poc -- status|trigger|inquiry');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store.close(); }
