import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHubClaims, needsHubBacklinkReconcile, reconcilePendingHubClaim, runHubReconcile, selectPendingHubClaims } from '../src/hub/reconcile.mjs';

const hub={required:true,integration:'convenience-discovery-v1',productId:'p1',expectedContentVersion:'aaaaaaaaaaaaaaaaaaaa'};
function pending(slotId='s1',publishedAt='2026-08-14T00:00:00Z'){return{slotId,account:'c',platform:'x',status:'published',hub,providerPostId:`post-${slotId}`,publishedAt}}

test('pending selector only accepts durable published Hub claims without a valid sync marker',()=>{
  assert.equal(needsHubBacklinkReconcile(pending()),true);
  assert.equal(needsHubBacklinkReconcile({...pending(),hubBacklinkSyncedAt:'2026-08-14T01:00:00Z'}),false);
  assert.equal(needsHubBacklinkReconcile({...pending(),hubBacklinkSyncedAt:'invalid'}),true);
  assert.equal(needsHubBacklinkReconcile({...pending(),status:'publishing'}),false);
  assert.equal(needsHubBacklinkReconcile({...pending(),hub:null}),false);
  assert.equal(needsHubBacklinkReconcile({...pending(),providerPostId:null}),false);
});

test('selector repairs oldest pending claims first and bounds one run',()=>{
  const rows=[pending('new','2026-08-14T03:00:00Z'),pending('old','2026-08-14T01:00:00Z'),pending('mid','2026-08-14T02:00:00Z')];
  const picked=selectPendingHubClaims(rows,2);
  assert.equal(picked.total,3);
  assert.deepEqual(picked.selected.map((row)=>row.slotId),['old','mid']);
  assert.equal(selectPendingHubClaims(rows,'bad').selected.length,3);
});

test('claim discovery reads durable-state tree and surfaces unreadable records instead of hiding them',async()=>{
  const encoded=Buffer.from(JSON.stringify(pending('good'))).toString('base64');
  const request=async(path)=>{
    if(path.includes('/branches/'))return{commit:{commit:{tree:{sha:'tree1'}}}};
    if(path.includes('/git/trees/'))return{truncated:false,tree:[{type:'blob',path:'data/durable-claims/a.json',sha:'a'},{type:'blob',path:'data/durable-claims/b.json',sha:'b'},{type:'blob',path:'other.json',sha:'x'}]};
    if(path.endsWith('/a'))return{content:encoded};
    if(path.endsWith('/b'))return{content:Buffer.from('{bad json').toString('base64')};
    throw new Error(`unexpected ${path}`);
  };
  const loaded=await loadHubClaims({context:()=>({repository:'owner/repo'}),request,concurrency:2});
  assert.equal(loaded.claims.length,1);
  assert.equal(loaded.claims[0].slotId,'good');
  assert.equal(loaded.unreadable.length,1);
  await assert.rejects(()=>loadHubClaims({context:()=>({repository:'owner/repo'}),request:async(path)=>path.includes('/branches/')?{commit:{commit:{tree:{sha:'t'}}}}:{truncated:true,tree:[]}}),error=>error.code==='HUB_RECONCILE_TREE_TRUNCATED');
  await assert.rejects(()=>loadHubClaims({context:()=>({repository:'broken'}),request}),/GITHUB_REPOSITORY/);
});

test('reconciliation performs only Hub backlink bookkeeping and marks the same published claim',async()=>{
  const writes=[];let syncContext=null;
  const result=await reconcilePendingHubClaim(pending('s2'),{
    resolve:async()=>({platform:'x'}),
    sync:async(context)=>{syncContext=context;return{url:'https://x.com/i/web/status/post-s2',sync:{changed:true}}},
    writeClaim:async(...args)=>{writes.push(args);return{}},
    now:()=>new Date('2026-08-14T04:00:00Z')
  });
  assert.equal(syncContext.postId,'post-s2');
  assert.deepEqual(writes[0].slice(0,2),['s2','published']);
  assert.equal(writes[0][2].hubBacklinkSyncedAt,'2026-08-14T04:00:00.000Z');
  assert.equal(result.changed,true);
  assert.deepEqual(await reconcilePendingHubClaim({...pending(),hubBacklinkSyncedAt:'2026-08-14T04:00:00Z'}),{skipped:true,slotId:'s1'});
});

test('runner is clean, partial, and degraded without ever inventing provider retries',async()=>{
  assert.equal((await runHubReconcile({load:async()=>({claims:[],unreadable:[]})})).state,'clean');
  const rows=[pending('a','2026-08-14T01:00:00Z'),pending('b','2026-08-14T02:00:00Z'),pending('c','2026-08-14T03:00:00Z')];
  const partial=await runHubReconcile({limit:2,load:async()=>({claims:rows,unreadable:[]}),reconcile:async(claim)=>({slotId:claim.slotId})});
  assert.equal(partial.state,'partial');
  assert.equal(partial.repaired.length,2);
  const degraded=await runHubReconcile({load:async()=>({claims:[pending('bad')],unreadable:[]}),reconcile:async()=>{throw new Error('hub down')}});
  assert.equal(degraded.state,'degraded');
  assert.match(degraded.errors[0].error,/hub down/);
  const unreadable=await runHubReconcile({load:async()=>({claims:[],unreadable:[{file:'bad'}]})});
  assert.equal(unreadable.state,'degraded');
});
