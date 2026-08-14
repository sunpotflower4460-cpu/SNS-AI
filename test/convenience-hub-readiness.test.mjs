import assert from 'node:assert/strict';
import test from 'node:test';
import {waitForHubReady} from '../src/hub/readiness.mjs';
const input={productId:'p1',expectedContentVersion:'aaaaaaaaaaaaaaaaaaaa'};
test('waiter polls until exact Hub readiness becomes true',async()=>{let calls=0,clock=0,sleeps=0;const result=await waitForHubReady(input,{timeoutMs:1000,pollMs:100,getReadiness:async()=>({ready:++calls>=3}),sleepImpl:async(ms)=>{sleeps++;clock+=ms},now:()=>clock});assert.equal(result.ready,true);assert.equal(calls,3);assert.equal(sleeps,2)});
test('waiter times out without publishing-side effects',async()=>{let clock=0;await assert.rejects(()=>waitForHubReady(input,{timeoutMs:250,pollMs:100,getReadiness:async()=>({ready:false}),sleepImpl:async(ms)=>{clock+=ms},now:()=>clock}),error=>error.code==='HUB_READY_TIMEOUT')});
test('waiter retries transient health errors but fails immediately on configuration errors',async()=>{let calls=0,clock=0;const ok=await waitForHubReady(input,{timeoutMs:500,pollMs:100,getReadiness:async()=>{calls++;if(calls===1)throw Object.assign(new Error('transient'),{code:'ECONNRESET'});return{ready:true}},sleepImpl:async(ms)=>{clock+=ms},now:()=>clock});assert.equal(ok.ready,true);await assert.rejects(()=>waitForHubReady(input,{getReadiness:async()=>{throw Object.assign(new Error('bad config'),{code:'HUB_CONFIG'})}}),error=>error.code==='HUB_CONFIG')});
