import test from 'node:test';
import assert from 'node:assert/strict';
import { postHasLink, urlPostUsage, resolveLinkPolicy, decideLinkUsage, resolveLinkUrl } from '../src/research/link-policy.mjs';
import { stripUrls, applyLinkPolicy } from '../src/content/link-gate.mjs';

test('postHasLink and stripUrls detect/remove URLs without disturbing surrounding text', () => {
  assert.equal(postHasLink({ text: '新しいプラグイン https://example.com/plugin をチェック' }), true);
  assert.equal(postHasLink({ text: 'リンクなしの投稿です' }), false);
  const stripped = stripUrls('新しいプラグイン https://example.com/plugin をチェック 。');
  assert.equal(/https?:\/\//.test(stripped), false);
  assert.match(stripped, /新しいプラグイン/);
});

test('resolveLinkPolicy falls back to unlimited defaults when unconfigured', () => {
  const policy = resolveLinkPolicy({});
  assert.equal(policy.preferNoLink, false);
  assert.equal(policy.maxUrlPostsPerWeek, null);
  assert.equal(policy.maxUrlPostsPerDay, null);
});

test('urlPostUsage counts only published entries with a link, within day/week windows', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const history = [
    { account: 'a', status: 'published', text: 'no link', at: '2026-08-28T01:00:00Z' },
    { account: 'a', status: 'published', text: 'has https://x.example', at: '2026-08-28T02:00:00Z' },
    { account: 'a', status: 'published', text: 'has https://x.example', at: '2026-08-25T02:00:00Z' },
    { account: 'a', status: 'published', text: 'has https://x.example', at: '2026-08-01T02:00:00Z' },
    { account: 'b', status: 'published', text: 'has https://x.example', at: '2026-08-28T02:00:00Z' },
    { account: 'a', status: 'skipped', text: 'has https://x.example', at: '2026-08-28T03:00:00Z' }
  ];
  const usage = urlPostUsage(history, 'a', 'UTC', now);
  assert.equal(usage.daily, 1);
  assert.equal(usage.weekly, 2);
});

test('decideLinkUsage enforces daily and weekly caps and purpose allowlist', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const account = { schedule: { timezone: 'UTC' }, linkPolicy: { maxUrlPostsPerDay: 1, maxUrlPostsPerWeek: 2, purposes: ['affiliate'] } };
  const history = [{ account: 'music-tools-x', status: 'published', text: 'https://a.example', at: '2026-08-28T01:00:00Z' }];

  const overDaily = decideLinkUsage({ accountId: 'music-tools-x', account, history, wantsLink: true, purpose: 'affiliate', now });
  assert.equal(overDaily.allowed, false);
  assert.match(overDaily.reason, /daily URL post cap/);

  const wrongPurpose = decideLinkUsage({ accountId: 'music-tools-x', account: { ...account, linkPolicy: { ...account.linkPolicy, maxUrlPostsPerDay: 5 } }, history, wantsLink: true, purpose: 'unlisted', now });
  assert.equal(wrongPurpose.allowed, false);
  assert.match(wrongPurpose.reason, /purpose/);

  const allowed = decideLinkUsage({ accountId: 'music-tools-x', account: { ...account, linkPolicy: { ...account.linkPolicy, maxUrlPostsPerDay: 5 } }, history, wantsLink: true, purpose: 'affiliate', now });
  assert.equal(allowed.allowed, true);

  const notRequested = decideLinkUsage({ accountId: 'music-tools-x', account, history, wantsLink: false, now });
  assert.equal(notRequested.allowed, false);
  assert.equal(notRequested.reason, 'not-requested');
});

test('decideLinkUsage enforces the weekly cap even when the daily cap alone would allow the post', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const account = { schedule: { timezone: 'UTC' }, linkPolicy: { maxUrlPostsPerDay: 5, maxUrlPostsPerWeek: 2, purposes: [] } };
  const history = [
    { account: 'music-tools-x', status: 'published', text: 'https://a.example', at: '2026-08-25T01:00:00Z' },
    { account: 'music-tools-x', status: 'published', text: 'https://a.example', at: '2026-08-26T01:00:00Z' }
  ];
  const overWeekly = decideLinkUsage({ accountId: 'music-tools-x', account, history, wantsLink: true, now });
  assert.equal(overWeekly.allowed, false);
  assert.match(overWeekly.reason, /weekly URL post cap/);
  assert.equal(overWeekly.usage.daily, 0, 'the daily count alone must not have blocked this - confirms the weekly branch is what fired');
});

test('decideLinkUsage never caps an account without an explicit linkPolicy (backward compatibility)', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const history = Array.from({ length: 20 }, (_, i) => ({ account: 'example-x', status: 'published', text: 'https://a.example', at: new Date(now.getTime() - i * 3600000).toISOString() }));
  const decision = decideLinkUsage({ accountId: 'example-x', account: {}, history, wantsLink: true, now });
  assert.equal(decision.allowed, true);
});

test('resolveLinkUrl prefers affiliate URL only when affiliate monetization is enabled, else falls back to official', () => {
  const disabled = resolveLinkUrl({ account: { monetization: { affiliate: { enabled: false } } }, officialUrl: 'https://vendor.example', affiliateUrl: 'https://aff.example' });
  assert.deepEqual(disabled, { url: 'https://vendor.example', kind: 'official' });

  const enabled = resolveLinkUrl({ account: { monetization: { affiliate: { enabled: true } } }, officialUrl: 'https://vendor.example', affiliateUrl: 'https://aff.example' });
  assert.deepEqual(enabled, { url: 'https://aff.example', kind: 'affiliate' });

  const none = resolveLinkUrl({ account: {}, officialUrl: null, affiliateUrl: null });
  assert.deepEqual(none, { url: null, kind: 'none' });
});

test('applyLinkPolicy strips the URL from a draft that exceeds the configured budget, and is a no-op without a link', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const account = { schedule: { timezone: 'UTC' }, linkPolicy: { maxUrlPostsPerDay: 0 } };
  const history = [];
  const draftWithLink = { text: '新製品です https://vendor.example/plugin', features: {} };
  const { draft, decision } = applyLinkPolicy({ accountId: 'music-tools-x', account, draft: draftWithLink, history, now });
  assert.equal(decision.allowed, false);
  assert.equal(/https?:\/\//.test(draft.text), false);
  assert.equal(draft.features.linkRequired, false);

  const draftNoLink = { text: 'リンクなし投稿', features: {} };
  const passthrough = applyLinkPolicy({ accountId: 'music-tools-x', account, draft: draftNoLink, history, now });
  assert.equal(passthrough.draft, draftNoLink);
  assert.equal(passthrough.decision.allowed, true);
});
