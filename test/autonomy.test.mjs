import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveScheduleTimes } from '../src/lib/schedule.mjs';
import { assignmentForSlot } from '../src/experiments/engine.mjs';
import { scanSecrets } from '../src/ops/secret-scan.mjs';

test('adaptive schedule stays inside human-provided candidate times', () => {
  const account = {
    schedule: { times: ['08:00', '20:00'], adaptiveCandidateTimes: ['08:00', '12:00', '20:00'] },
    learning: { adaptiveSchedule: true, adaptiveScheduleMinConfidence: 0.4, adaptiveScheduleKeepAtLeast: 1 }
  };
  const strategy = {
    confidence: 0.9,
    featureStats: { postingHour: {
      '08:00': { averageScore: 70, confidence: 0.8 },
      '12:00': { averageScore: 92, confidence: 0.8 },
      '20:00': { averageScore: 45, confidence: 0.8 }
    } }
  };
  assert.deepEqual(effectiveScheduleTimes(account, strategy), ['08:00', '12:00']);
});

test('adaptive schedule does nothing without approved candidate-time expansion', () => {
  const account = { schedule: { times: ['08:00', '20:00'] }, learning: { adaptiveSchedule: true } };
  assert.deepEqual(effectiveScheduleTimes(account, { confidence: 1, featureStats: {} }), ['08:00', '20:00']);
});

test('experiment assignments are deterministic and use both variants over many slots', () => {
  const experiment = { id: 'exp-1', status: 'active', dimension: 'hook', variants: ['question', 'statement'] };
  const first = assignmentForSlot(experiment, 'slot-1');
  assert.deepEqual(first, assignmentForSlot(experiment, 'slot-1'));
  const variants = new Set(Array.from({ length: 50 }, (_, i) => assignmentForSlot(experiment, `slot-${i}`)?.variant));
  assert.deepEqual([...variants].sort(), ['question', 'statement']);
});

test('repository source contains no obvious literal secrets', async () => {
  assert.deepEqual(await scanSecrets(), []);
});
