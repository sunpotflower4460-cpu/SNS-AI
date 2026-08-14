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

test('music-tools-x owns its discovery positioning and persona without changing other accounts', async () => {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const account = config.accounts['music-tools-x'];

  assert.equal(account.profile?.concept, '海外のまだ知られていない良いプラグインを発掘して、買う価値まで日本語で判断する。');
  assert.equal(account.profile?.tagline, 'まだ知られていない音を、先に見つける。');
  assert.match(account.profile?.primaryPersona?.summary || '', /海外まで毎日掘る時間はないDTMer/);
  assert.match(account.profile?.primaryPersona?.followReason || '', /買う・見送る判断材料/);
  assert.ok(account.profile?.brandPromise?.includes('買わなくてよい場合は明確にそう言う'));
  assert.ok(account.profile?.brandPromise?.includes('affiliateの有無や報酬率で推薦順位を変えない'));
  assert.match(account.instructions || '', /小規模デベロッパー/);
  assert.match(account.instructions || '', /見送ってよい/);
  assert.match(account.instructions || '', /affiliateの有無・報酬率/);

  assert.equal(config.accounts['example-x']?.profile?.concept, undefined);
  assert.equal(config.accounts['example-x']?.profile?.primaryPersona, undefined);
  assert.equal(config.accounts['example-instagram']?.profile?.concept, undefined);
  assert.equal(config.accounts['example-instagram']?.profile?.primaryPersona, undefined);
});
