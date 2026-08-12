import test from 'node:test';
import assert from 'node:assert/strict';
import { similarity, findNearDuplicate } from '../src/lib/duplicate.mjs';
import { findDueSlots, validateTimeString } from '../src/lib/schedule.mjs';
import { checkRateLimits } from '../src/lib/safety.mjs';

test('duplicate similarity catches nearly identical Japanese text', () => {
  const a = 'AIを使って毎日の作業を少しずつ自動化しています。';
  const b = 'AIを使って毎日の作業を少しずつ自動化しています！';
  assert.ok(similarity(a, b) > 0.8);
  assert.ok(findNearDuplicate(b, [{ text: a }], 0.72));
});

test('different posts are not treated as duplicates', () => {
  assert.ok(similarity('今日はAIについて学んだ', '週末は料理を作った') < 0.4);
});

test('schedule finds a due slot in Asia/Tokyo', () => {
  const account = {
    schedule: {
      timezone: 'Asia/Tokyo',
      days: ['wed'],
      times: ['18:20'],
      windowMinutes: 30
    }
  };
  const now = new Date('2026-08-12T09:25:00Z');
  const slots = findDueSlots('demo', account, now);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].slotId, 'demo:2026-08-12:18:20');
});

test('time validation', () => {
  assert.equal(validateTimeString('08:00'), true);
  assert.equal(validateTimeString('25:00'), false);
  assert.equal(validateTimeString('8:00'), false);
});

test('rate limit blocks too many posts', () => {
  const account = {
    schedule: { timezone: 'Asia/Tokyo' },
    safety: { maxPostsPerDay: 1, minMinutesBetweenPosts: 0 }
  };
  const history = [{
    account: 'demo',
    status: 'published',
    at: '2026-08-12T00:00:00Z',
    text: 'one'
  }];
  const result = checkRateLimits('demo', account, history, new Date('2026-08-12T09:00:00Z'));
  assert.equal(result.ok, false);
});
