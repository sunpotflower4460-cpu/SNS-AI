import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CONFIG = new URL('../config/accounts.json', import.meta.url);

test('music-tools-x stays research-enabled but cannot publish before explicit activation', async () => {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const account = config.accounts?.['music-tools-x'];

  assert.ok(account, 'music-tools-x account must exist');
  assert.equal(account.platform, 'x');
  assert.equal(account.enabled, false, 'production account must remain disabled until external setup is complete');
  assert.equal(account.mode, 'approval', 'first live phase must require approval');
  assert.equal(account.credentialKey, 'music-tools-x');

  assert.equal(account.research?.webSearch, true);
  assert.equal(account.research?.trendIntelligence, true);
  assert.ok(Number(account.research?.trendRefreshHours) > 0);

  assert.equal(account.media?.strategy, 'none', 'initial launch stays text-only to avoid premature media OAuth requirements');
  assert.equal(account.safety?.maxPostsPerDay, 2);
  assert.ok(Number(account.safety?.minMinutesBetweenPosts) >= 360);
  assert.ok(Number(account.safety?.maxLinks) <= 1);
  assert.ok(Number(account.safety?.maxHashtags) <= 2);

  assert.ok(Array.isArray(account.profile?.topics) && account.profile.topics.length >= 10);
  assert.match(account.instructions || '', /Web Search/);
  assert.match(account.instructions || '', /一次情報/);
  assert.match(account.instructions || '', /使用感.*捏造|使用した.*捏造/);
});
