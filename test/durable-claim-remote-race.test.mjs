import test from 'node:test';
import assert from 'node:assert/strict';
import { beginPublishClaim, __test as claimTest } from '../src/lib/durable-claim.mjs';

// Every existing remote-path durable-claim test scripts the "who won" outcome by hand (flip a flag
// between sequential calls). None of them ever actually race two concurrent beginPublishClaim() calls
// against a single stateful, sha-versioned mock of GitHub's real Contents API - which is exactly the
// production scenario (two overlapping runners / a retried CI run racing a still-in-flight one) that
// Step 3 Case A of the independent audit asks to reproduce. This file backs the mock with real
// create/update sha semantics (PUT without a matching current sha is rejected, mirroring GitHub's
// actual behavior) and fires two beginPublishClaim() calls concurrently via Promise.allSettled (not
// Promise.all, since exactly one call is expected to reject with SLOT_ALREADY_CLAIMED in the
// reject-instead-of-replay outcome, and Promise.all would short-circuit on that rejection before the
// test ever got to inspect the winner's result).

function saveEnv(...names) { return Object.fromEntries(names.map((name) => [name, process.env[name]])); }
function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function encode(value) { return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8').toString('base64'); }

// A minimal but behaviorally faithful stand-in for GitHub's Contents API create/update semantics:
// - GET on a missing path -> 404
// - PUT with no `sha` on an EXISTING path -> 422 (GitHub requires the current sha to update)
// - PUT with a `sha` that doesn't match the current stored sha -> 409 (stale write, real conflict)
// - otherwise: the write succeeds and a new sha is minted
function createStatefulContentsMock() {
  const store = new Map(); // path -> { sha, content }
  let shaCounter = 0;
  let putCount = 0;
  return {
    putCount: () => putCount,
    fetch: async (url, options = {}) => {
      const target = String(url);
      const pathMatch = target.match(/\/repos\/owner\/repo\/contents\/(.+?)(?:\?ref=.*)?$/);
      if (!pathMatch) throw new Error(`Unexpected mocked URL: ${target}`);
      const path = decodeURIComponent(pathMatch[1]);
      const method = (options.method || 'GET').toUpperCase();
      if (method === 'GET') {
        // The snapshot MUST be captured before the delay, not after: if it were read after waking up,
        // the first caller's PUT (which has no artificial delay) could complete and mutate `store`
        // during the second caller's wait, so the second caller would read the ALREADY-WRITTEN state
        // instead of a genuine pre-write snapshot - silently turning this into a sequential
        // read-after-write test that never exercises the sha-conflict path at all. Capturing here and
        // only delaying the response delivery is what actually forces both callers to have raced from
        // the same pre-write view, regardless of which one's timer fires first.
        const row = store.get(path);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (!row) return jsonResponse({ message: 'Not Found' }, 404);
        return jsonResponse({ content: row.content, sha: row.sha });
      }
      if (method === 'PUT') {
        putCount += 1;
        const body = JSON.parse(options.body);
        const existing = store.get(path);
        if (existing && !body.sha) return jsonResponse({ message: 'sha wasn\'t supplied' }, 422);
        if (existing && body.sha !== existing.sha) return jsonResponse({ message: 'does not match' }, 409);
        if (!existing && body.sha) return jsonResponse({ message: 'sha supplied but file does not exist' }, 422);
        shaCounter += 1;
        const sha = `sha-${shaCounter}`;
        store.set(path, { sha, content: body.content });
        return jsonResponse({ content: { sha } }, existing ? 200 : 201);
      }
      throw new Error(`Unexpected mocked method: ${method} ${target}`);
    }
  };
}

test('two concurrent beginPublishClaim() calls for the same slot against a real sha-versioned mock: exactly one wins, the other never proceeds to publish', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  claimTest.resetForTests();
  const slotId = 'race:2026-08-13:runner-a-vs-runner-b';
  const mock = createStatefulContentsMock();

  try {
    globalThis.fetch = mock.fetch;

    // Two independent "runners" (in production: two separate Node processes / GitHub Actions jobs)
    // both discover the slot is unclaimed and race to claim it. claimTest.resetForTests() above
    // clears the process-local memory/shaMemory caches so this genuinely exercises two independent
    // cold reads, not a warm in-process cache hit.
    const [outcomeA, outcomeB] = await Promise.allSettled([
      beginPublishClaim(slotId, { account: 'race-acct', runner: 'A' }),
      beginPublishClaim(slotId, { account: 'race-acct', runner: 'B' })
    ]);

    const results = [outcomeA, outcomeB];
    const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.reason);

    // Exactly one caller must have actually won the claim (claimed:true, replay:false) - a caller
    // that wins is the only one allowed to proceed to actually call the provider.
    const winners = fulfilled.filter((v) => v.claimed === true);
    assert.equal(winners.length, 1, `expected exactly one winner, got fulfilled=${JSON.stringify(fulfilled)} rejected=${rejected.map((e) => e.message)}`);

    // The loser must either be told to replay (if it observed the winner's claim as already
    // 'published' by the time it reconciled) or be explicitly refused with SLOT_ALREADY_CLAIMED -
    // in neither case does it receive claimed:true, so neither case lets it call the provider.
    const loserOutcome = fulfilled.find((v) => v.claimed !== true) || rejected[0];
    if (rejected.length) {
      assert.equal(rejected[0].code, 'SLOT_ALREADY_CLAIMED', `the losing caller must be refused with SLOT_ALREADY_CLAIMED, got: ${rejected[0]?.message}`);
    } else {
      assert.equal(loserOutcome.claimed, false);
    }

    // Because both callers' GET snapshots are captured before the artificial network delay (see the
    // mock above), they are guaranteed to race from the same pre-write view every run - so this must be
    // exactly 2 PUTs (winner's create + loser's rejected create) every time, not just "at most 2". A
    // loose upper bound would still pass even if timing accidentally let the loser observe the winner's
    // write during its own GET and skip the PUT conflict entirely (putCount === 1), silently degrading
    // this into a test that never actually exercises the sha-conflict path.
    assert.equal(mock.putCount(), 2, `expected exactly 2 PUT attempts (winner's create + loser's rejected create), got ${mock.putCount()}`);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    claimTest.resetForTests();
  }
});
