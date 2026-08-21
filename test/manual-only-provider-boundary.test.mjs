import test from 'node:test';
import assert from 'node:assert/strict';
import { publishX } from '../src/providers/x.mjs';
import { publishInstagram } from '../src/providers/instagram.mjs';
import { sendXReply, sendXDirectMessage } from '../src/engagement/providers/x.mjs';
import { sendInstagramCommentReply, sendInstagramPrivateReply, sendInstagramDm } from '../src/engagement/providers/instagram.mjs';

async function withoutManualInvocation(run) {
  const previous = process.env.SNS_MANUAL_INVOCATION;
  delete process.env.SNS_MANUAL_INVOCATION;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.SNS_MANUAL_INVOCATION;
    else process.env.SNS_MANUAL_INVOCATION = previous;
  }
}

async function blocked(promiseFactory) {
  await assert.rejects(
    () => withoutManualInvocation(promiseFactory),
    (error) => error?.code === 'MANUAL_ONLY_BLOCKED'
  );
}

test('direct X publish cannot cross a live provider boundary without the manual marker', async () => {
  await blocked(() => publishX({
    text: 'test',
    credential: { consumerKey: 'a', consumerSecret: 'b', accessToken: 'c', accessTokenSecret: 'd' },
    dryRun: false
  }));
});

test('direct Instagram publish cannot cross a live provider boundary without the manual marker', async () => {
  await blocked(() => publishInstagram({
    mediaUrl: 'https://example.com/test.jpg',
    credential: { accessToken: 'test', igUserId: '123' },
    dryRun: false
  }));
});

test('direct X reply and DM cannot cross live provider boundaries without the manual marker', async () => {
  const credential = { oauth2AccessToken: 'test' };
  await blocked(() => sendXReply({ credential, postId: '123', text: 'reply', dryRun: false }));
  await blocked(() => sendXDirectMessage({ credential, participantId: '456', text: 'dm', dryRun: false }));
});

test('direct Instagram reply and DM paths cannot cross live provider boundaries without the manual marker', async () => {
  const common = { accessToken: 'test', apiVersion: 'v25.0', dryRun: false };
  await blocked(() => sendInstagramCommentReply({ ...common, commentId: '123', message: 'reply' }));
  await blocked(() => sendInstagramPrivateReply({ ...common, igUserId: '1', commentId: '123', message: 'private' }));
  await blocked(() => sendInstagramDm({ ...common, igUserId: '1', recipientId: '456', message: 'dm' }));
});
