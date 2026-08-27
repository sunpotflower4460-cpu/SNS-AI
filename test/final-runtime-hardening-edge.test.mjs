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

test('durable published replay refuses claims that lack account/platform provenance', async () => {
  await assert.rejects(
    publishTest.reconcilePublishedReplay(
      { account: 'account-a', slotId: 'slot-missing-prov', text: 'x' },
      { platform: 'x' },
      { status: 'published', providerPostId: 'post-1' }
    ),
    /missing account\/platform provenance/
  );
});

test('published history evidence and already-recorded checks stay account/platform scoped', () => {
  const history = [
    { status: 'published', slotId: 'shared-slot', account: 'other', platform: 'x', providerPostId: 'p1' },
    { status: 'published', slotId: 'shared-slot', account: 'account-a', platform: 'instagram', providerPostId: 'p2' },
    // Missing identity must fail closed, not act as a wildcard match.
    { status: 'published', slotId: 'shared-slot', providerPostId: 'orphan' }
  ];
  assert.equal(
    publishTest.publishedHistoryEvidence({ account: 'account-a', slotId: 'shared-slot' }, { platform: 'x' }, history),
    null
  );
  assert.equal(
    publishTest.publishedHistoryEvidence({ account: 'account-a', slotId: 'shared-slot' }, { platform: 'x' }, [
      { status: 'published', slotId: 'shared-slot', providerPostId: 'orphan' }
    ]),
    null
  );
  const matched = publishTest.publishedHistoryEvidence(
    { account: 'account-a', slotId: 'shared-slot' },
    { platform: 'instagram' },
    history
  );
  assert.equal(matched.providerPostId, 'p2');
});
