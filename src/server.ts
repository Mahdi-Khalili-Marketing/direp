import { createApp } from './app.js';
import { config } from './config.js';
import { openDb, getSetting } from './db.js';
import { runDueRecoveries } from './recovery.js';
import { expireFollowChecks } from './rules.js';

openDb(config.databasePath);
const app = createApp();

app.listen(config.port, () => {
  console.log(`Direp running on http://localhost:${config.port}`);
  console.log(`BoxAPI: ${config.boxApiBaseUrl}${config.dryRun ? ' (dry-run: nothing is sent)' : ''}`);
});

// One timer drives every delayed job; state lives in SQLite, so restarts lose nothing.
setInterval(async () => {
  try {
    await runDueRecoveries();
    const accountId = getSetting('account_id');
    if (accountId) await expireFollowChecks(accountId);
  } catch (err: any) {
    console.error('[scheduler]', err.message);
  }
}, config.schedulerIntervalSeconds * 1000);
