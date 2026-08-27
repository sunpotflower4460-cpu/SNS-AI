import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { __test as xTest } from '../src/engagement/providers/x.mjs';
import { __test as instagramTest } from '../src/engagement/providers/instagram.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('X token pagination merges pages and user expansions without duplicates', async () => {
  const seen = [];
  const result = await xTest.paginateX(async (token) => {
    seen.push(token);
    if (!token) return {
      data: [{ id: '3' }, { id: '2' }],
      includes: { users: [{ id: '20', username: 'a' }] },
      meta: { result_count: 2, next_token: 'page-2' }
    };
    return {
      data: [{ id: '1' }],
      includes: { users: [{ id: '20', username: 'a-newer-shape' }, { id: '10', username: 'b' }] },
      meta: { result_count: 1 }
    };
  }, { kind: 'mentions', maxPages: 5 });

  assert.deepEqual(seen, [null, 'page-2']);
  assert.deepEqual(result.data.map((row) => row.id), ['3', '2', '1']);
  assert.deepEqual(result.includes.users.map((row) => row.id).sort(), ['10', '20']);
  assert.equal(result.includes.users.find((row) => row.id === '20').username, 'a-newer-shape');
  assert.equal(result.meta.result_count, 3);
  assert.equal(result.meta.next_token, undefined);
});

test('X pagination fails closed when unread pages remain beyond the safety cap', async () => {
  let calls = 0;
  await assert.rejects(
    () => xTest.paginateX(async () => {
      calls += 1;
      return { data: [{ id: String(calls) }], meta: { next_token: `next-${calls}` } };
    }, { kind: 'DM events', maxPages: 2 }),
    (error) => error?.code === 'ENGAGEMENT_PAGINATION_TRUNCATED' && /2-page safety cap/.test(error.message)
  );
  assert.equal(calls, 2);
});

test('pagination page limits are bounded and malformed values use the safe default', () => {
  assert.equal(xTest.pageLimit('bad'), 5);
  assert.equal(xTest.pageLimit(0), 5);
  assert.equal(xTest.pageLimit(500), 20);
  assert.equal(instagramTest.pageLimit('bad'), 5);
  assert.equal(instagramTest.pageLimit(500), 20);
});

test('Instagram paging URLs remain on graph.instagram.com and strip query access tokens', () => {
  const safe = instagramTest.safePagingUrl('https://graph.instagram.com/v25.0/123/comments?after=cursor&access_token=secret-token');
  const parsed = new URL(safe);
  assert.equal(parsed.hostname, 'graph.instagram.com');
  assert.equal(parsed.searchParams.get('after'), 'cursor');
  assert.equal(parsed.searchParams.has('access_token'), false);
  assert.throws(() => instagramTest.safePagingUrl('https://evil.example/v25.0/123/comments?after=x'), /trusted Graph API origin/);
  assert.throws(() => instagramTest.safePagingUrl('https://graph.instagram.com/not-versioned/comments?after=x'), /versioned Graph API path/);
});

test('Instagram cursor pagination follows trusted next links and merges all edge rows', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), authorization: options.headers?.Authorization });
      return json({
        data: [{ id: '2' }, { id: '1' }],
        paging: { cursors: { after: 'done' } }
      });
    };

    const result = await instagramTest.paginateGraphEdge({
      data: [{ id: '4' }, { id: '3' }],
      paging: {
        next: 'https://graph.instagram.com/v25.0/123/comments?after=page2&access_token=must-not-propagate',
        cursors: { after: 'page2' }
      }
    }, { accessToken: 'header-token', kind: 'comments', maxPages: 5 });

    assert.deepEqual(result.data.map((row) => row.id), ['4', '3', '2', '1']);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, 'Bearer header-token');
    assert.equal(requests[0].url.includes('must-not-propagate'), false);
    assert.equal(result.paging?.next, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Instagram pagination fails closed when the provider still exposes a next page at the cap', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => json({
      data: [{ id: '2' }],
      paging: { next: 'https://graph.instagram.com/v25.0/123/comments?after=page3' }
    });

    await assert.rejects(
      () => instagramTest.paginateGraphEdge({
        data: [{ id: '1' }],
        paging: { next: 'https://graph.instagram.com/v25.0/123/comments?after=page2' }
      }, { accessToken: 'header-token', kind: 'comments', maxPages: 2 }),
      (error) => error?.code === 'ENGAGEMENT_PAGINATION_TRUNCATED' && /2-page safety cap/.test(error.message)
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Failure Watch subscribes to scheduled engagement failures', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/failure-watch.yml`, 'utf8');
  assert.match(workflow, /- SNS Engagement Autopilot/);
  assert.match(workflow, /- SNS Engagement Scheduled/);
  assert.match(workflow, /- SNS Engagement Resolve/);
  assert.match(workflow, /- SNS ChatOps/);
  assert.match(workflow, /failure|timed_out|cancelled/);
});
