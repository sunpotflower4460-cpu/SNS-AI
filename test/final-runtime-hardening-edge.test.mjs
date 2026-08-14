import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStrictConfig } from '../src/validate-strict-config.mjs';
import { __test as publishTest } from '../src/publish.mjs';

test('strict config reports malformed media URL collections instead of throwing inside the validator', () => {
  const errors = validateStrictConfig({
    defaults: {},
    accounts: {
      demo: { platform: 'x', enabled: false, mode: 'pause', media: { strategy: 'pool', urls: { bad: true } } }
    }
  });
  assert.equal(errors.some((value) => value.includes('media.urls must be an array')), true);
});

test('durable published replay refuses an account or platform identity mismatch before touching bookkeeping', async () => {
  await assert.rejects(
    publishTest.reconcilePublishedReplay(
      { account: 'account-a', slotId: 'slot-1', text: 'x' },
      { platform: 'x' },
      { account: 'account-b', platform: 'x', status: 'published' }
    ),
    /Durable claim account mismatch/
  );
  await assert.rejects(
    publishTest.reconcilePublishedReplay(
      { account: 'account-a', slotId: 'slot-1', text: 'x' },
      { platform: 'x' },
      { account: 'account-a', platform: 'instagram', status: 'published' }
    ),
    /Durable claim platform mismatch/
  );
});
