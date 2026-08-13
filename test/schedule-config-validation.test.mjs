import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/validate-config.mjs';

function configWith(schedule) {
  return {
    defaults: {},
    accounts: {
      test: {
        platform: 'x',
        enabled: false,
        mode: 'pause',
        schedule
      }
    }
  };
}

test('schedule validation accepts valid IANA timezone days and window', () => {
  const errors = validateConfig(configWith({
    timezone: 'Asia/Tokyo',
    days: ['mon', 'wed', 'fri'],
    times: ['09:00', '23:50'],
    windowMinutes: 30
  }));
  assert.deepEqual(errors, []);
});

test('schedule validation rejects invalid IANA timezone', () => {
  const errors = validateConfig(configWith({
    timezone: 'Asia/Tokyoo',
    days: ['thu'],
    times: ['09:00'],
    windowMinutes: 30
  }));
  assert.ok(errors.some((error) => error.includes('invalid schedule timezone')));
});

test('schedule validation rejects unsupported weekday tokens', () => {
  const errors = validateConfig(configWith({
    timezone: 'Asia/Tokyo',
    days: ['monday', 'thu'],
    times: ['09:00'],
    windowMinutes: 30
  }));
  assert.ok(errors.some((error) => error.includes('invalid schedule day "monday"')));
});

test('schedule validation rejects zero negative and over-day windows', () => {
  for (const windowMinutes of [0, -1, 1441]) {
    const errors = validateConfig(configWith({
      timezone: 'Asia/Tokyo',
      days: ['thu'],
      times: ['09:00'],
      windowMinutes
    }));
    assert.ok(errors.some((error) => error.includes('schedule.windowMinutes must be 1..1440')), `expected invalid window ${windowMinutes}`);
  }
});
