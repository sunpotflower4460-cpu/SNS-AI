import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CONFIG = new URL('../config/accounts.json', import.meta.url);

test('music-tools-x is activated for the approval-mode launch with research enabled and publishing safeguards intact', async () => {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const account = config.accounts?.['music-tools-x'];

  assert.ok(account, 'music-tools-x account must exist');
  assert.equal(account.platform, 'x');
  // Explicit activation happened in the controlled-launch change (PR #100) after
  // external setup completed; approval mode still gates every publish.
  assert.equal(account.enabled, true, 'production account is activated for the controlled launch');
  assert.equal(account.mode, 'approval', 'first live phase must require approval');
  assert.equal(account.credentialKey, 'music-tools-x');

  assert.equal(account.research?.webSearch, true);
  assert.equal(account.research?.trendIntelligence, true);
  assert.ok(Number(account.research?.trendRefreshHours) > 0);

  assert.equal(account.media?.strategy, 'hunter', 'posts carry the real product image when the media hunter can obtain one (owner direction 2026-11-11: text-only is not enough)');
  assert.equal(account.media?.acquireFromCanonical, true, 'the hunter may extract the product image from the post canonical (product) page');
  assert.equal(account.media?.internalImageGeneration, false, 'AI-generated images must never stand in for product photos');
  assert.equal(account.safety?.maxPostsPerDay, 2);
  assert.ok(Number(account.safety?.minMinutesBetweenPosts) >= 360);
  assert.ok(Number(account.safety?.maxLinks) <= 1);
  assert.ok(Number(account.safety?.maxHashtags) <= 2);

  assert.ok(Array.isArray(account.profile?.topics) && account.profile.topics.length >= 10);
  assert.match(account.instructions || '', /Web Search/);
  assert.match(account.instructions || '', /一次情報/);
  assert.match(account.instructions || '', /使用感.*捏造|使用した.*捏造/);
});

test('music-tools-x runs the low-cost direct-fetch research path with a source-URL link policy, and affiliate stays disabled', async () => {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  const account = config.accounts['music-tools-x'];

  assert.equal(account.research?.directFetch, true);
  assert.ok(Number(account.research?.minDirectCandidates) > 0);

  // Owner direction 2026-11-11 supersedes the launch posture below: posts should carry the
  // researched product page URL (the previous caps of 1/day and 3/week plus preferNoLink made
  // linked posts the rare exception, which is exactly what is being reversed).
  assert.equal(account.linkPolicy?.preferNoLink, false);
  assert.equal(account.linkPolicy?.includeSourceUrl, true, 'drafts attach the researched product page URL when it fits');
  assert.equal(account.linkPolicy?.maxUrlPostsPerDay, null, 'no daily URL cap - the URL is a default part of the post, not a rationed extra');
  assert.equal(account.linkPolicy?.maxUrlPostsPerWeek, null, 'no weekly URL cap');
  assert.ok(Array.isArray(account.linkPolicy?.purposes) && account.linkPolicy.purposes.includes('product'));

  assert.equal(account.monetization?.affiliate?.enabled, false, 'no live affiliate rollout in this change');
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
