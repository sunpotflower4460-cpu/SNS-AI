import test from 'node:test';
import assert from 'node:assert/strict';
import {
  strongMatches,
  prepareProviderReadbackReconciliation,
  finalizeProviderReadbackReconciliation,
  __test
} from '../src/ops/publish-readback-reconcile.mjs';

const claim = {
  slotId: 'alpha:2026-08-20T10:00',
  account: 'alpha',
  platform: 'x',
  status: 'publish_unknown',
  text: 'New plugin https://example.com/product',
  createdAt: '2026-08-20T01:00:00.000Z',
  updatedAt: '2026-08-20T01:01:00.000Z'
};

test('strongMatches accepts one exact in-window provider post including expanded X URL', () => {
  const rows = strongMatches(claim, [
    {
      id: 'x1',
      text: 'New plugin https://t.co/abc',
      createdAt: '2026-08-20T01:00:30.000Z',
      entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/product' }] }
    },
    { id: 'x2', text: claim.text, createdAt: '2026-08-20T04:00:00.000Z' }
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['x1']);
});

test('strongMatches refuses ambiguous duplicates and claims without exact text', () => {
  const duplicate = { id: 'a', text: claim.text, createdAt: '2026-08-20T01:00:10.000Z' };
  assert.equal(strongMatches(claim, [duplicate, { ...duplicate, id: 'b' }]).length, 2);
  assert.deepEqual(strongMatches({ ...claim, text: '' }, [duplicate]), []);
});

test('prepare reconciliation mutates local records only for one strong provider match', async () => {
  const persisted = [];
  const result = await prepareProviderReadbackReconciliation({
    minAgeMinutes: 10,
    deps: {
      findStuckClaims: async () => ({ skipped: false, stuck: [{ slotId: claim.slotId }], truncated: false }),
      getDurableClaim: async () => claim,
      resolveAccount: async () => ({ platform: 'x', credential: {} }),
      providerCandidates: async () => [{ id: 'x1', text: claim.text, createdAt: '2026-08-20T01:00:20.000Z' }],
      persistLocalConfirmation: async (seenClaim, candidate) => {
        persisted.push([seenClaim.slotId, candidate.id]);
        return { slotId: seenClaim.slotId, providerPostId: candidate.id, providerCreatedAt: candidate.createdAt };
      }
    }
  });
  assert.equal(result.confirmed.length, 1);
  assert.deepEqual(persisted, [[claim.slotId, 'x1']]);
});

test('prepare reconciliation leaves zero/multiple matches unresolved and never invents success', async () => {
  let persisted = 0;
  const result = await prepareProviderReadbackReconciliation({
    deps: {
      findStuckClaims: async () => ({ skipped: false, stuck: [{ slotId: claim.slotId }], truncated: false }),
      getDurableClaim: async () => claim,
      resolveAccount: async () => ({ platform: 'x', credential: {} }),
      providerCandidates: async () => [],
      persistLocalConfirmation: async () => { persisted += 1; }
    }
  });
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.unresolved[0].reason, 'no_unique_provider_match');
  assert.equal(persisted, 0);
});

test('prepare reconciliation fails closed for malformed claims, platform mismatch, and provider errors', async () => {
  const malformed = await prepareProviderReadbackReconciliation({
    deps: {
      findStuckClaims: async () => ({ skipped: false, stuck: [{ slotId: 'm' }], truncated: false }),
      getDurableClaim: async () => ({ ...claim, slotId: 'm', text: '' }),
      resolveAccount: async () => { throw new Error('should not resolve'); }
    }
  });
  assert.equal(malformed.unresolved[0].reason, 'insufficient_claim_evidence');

  const mismatch = await prepareProviderReadbackReconciliation({
    deps: {
      findStuckClaims: async () => ({ skipped: false, stuck: [{ slotId: 'p' }], truncated: false }),
      getDurableClaim: async () => ({ ...claim, slotId: 'p' }),
      resolveAccount: async () => ({ platform: 'instagram' })
    }
  });
  assert.equal(mismatch.unresolved[0].reason, 'platform_mismatch');

  const failed = await prepareProviderReadbackReconciliation({
    deps: {
      findStuckClaims: async () => ({ skipped: false, stuck: [{ slotId: 'e' }], truncated: false }),
      getDurableClaim: async () => ({ ...claim, slotId: 'e' }),
      resolveAccount: async () => ({ platform: 'x' }),
      providerCandidates: async () => { throw new Error('provider unavailable'); }
    }
  });
  assert.equal(failed.unresolved[0].reason, 'readback_error');
});

test('prepare reconciliation preserves skipped and truncated diagnostics', async () => {
  const skipped = await prepareProviderReadbackReconciliation({
    deps: { findStuckClaims: async () => ({ skipped: true, reason: 'state-unavailable' }) }
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'state-unavailable');

  const truncated = await prepareProviderReadbackReconciliation({
    deps: { findStuckClaims: async () => ({ skipped: false, stuck: [], truncated: true }) }
  });
  assert.equal(truncated.truncated, true);
});

test('finalize only transitions claims that are still ambiguous after main persistence', async () => {
  const writes = [];
  const entries = [{ slotId: claim.slotId, providerPostId: 'x1', providerCreatedAt: '2026-08-20T01:00:20.000Z' }];
  const result = await finalizeProviderReadbackReconciliation(entries, {
    getClaim: async () => claim,
    finishClaim: async (slotId, status, detail) => {
      writes.push({ slotId, status, detail });
      return { status };
    }
  });
  assert.equal(result.finalized.length, 1);
  assert.equal(writes[0].status, 'published');
  assert.equal(writes[0].detail.providerPostId, 'x1');

  const skipped = await finalizeProviderReadbackReconciliation(entries, {
    getClaim: async () => ({ ...claim, status: 'published' }),
    finishClaim: async () => { throw new Error('must not write'); }
  });
  assert.equal(skipped.finalized.length, 0);
  assert.equal(skipped.skipped[0].reason, 'published');
});

test('OAuth1 signing and parser/helper boundaries stay conservative', () => {
  const header = __test.oauth1Header('GET', 'https://api.x.com/2/users/1/tweets?max_results=100&tweet.fields=created_at%2Centities', {
    consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as'
  });
  assert.match(header, /^OAuth /);
  assert.equal(__test.cleanText(' a\r\nb '), 'a\nb');
  assert.equal(__test.cleanText(null), '');
  assert.equal(__test.claimWindow({ createdAt: 'bad' }), null);
  assert.equal(__test.candidateTime({ timestamp: '2026-08-20T01:00:00Z' }), Date.parse('2026-08-20T01:00:00Z'));
  assert.equal(__test.candidateTime({ timestamp: 'bad' }), null);
  assert.equal(__test.expandXUrls('go https://t.co/a', { urls: [{ url: 'https://t.co/a', expanded_url: 'https://example.com/a' }] }), 'go https://example.com/a');
  assert.deepEqual(__test.parseArgs(['--min-age-minutes', '15', '--out', '/tmp/a', '--finalize-file', '/tmp/b']), {
    minAgeMinutes: 15, out: '/tmp/a', finalizeFile: '/tmp/b'
  });
  assert.throws(() => __test.oauth1Header('GET', 'https://api.x.com/2/users/me', {}), /missing/);
});

test('invalid min age is rejected before any provider or durable-state work', async () => {
  await assert.rejects(() => prepareProviderReadbackReconciliation({ minAgeMinutes: 0 }), /positive number/);
});
