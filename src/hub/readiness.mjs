import { getHubReadiness } from './convenience-hub.mjs';

const sleepDefault=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
function timeoutError(input,last,lastError){const error=new Error(`SNS-HUB did not become ready for ${input.productId} at ${input.expectedContentVersion} before timeout.`);error.code='HUB_READY_TIMEOUT';error.publishStage='hub';error.lastReadiness=last||null;error.cause=lastError||undefined;return error}
export async function waitForHubReady(input,{timeoutMs=10*60_000,pollMs=5_000,getReadiness=getHubReadiness,sleepImpl=sleepDefault,now=()=>Date.now(),...readinessOptions}={}){
  const timeout=Math.max(1,Math.min(60*60_000,Number(timeoutMs)||0)),poll=Math.max(100,Math.min(60_000,Number(pollMs)||0)),deadline=now()+timeout;let last=null,lastError=null;
  for(;;){
    try{last=await getReadiness(input,readinessOptions);lastError=null;if(last?.ready)return last}catch(error){if(['HUB_CONFIG','HUB_VALIDATION','HUB_SECURITY'].includes(error?.code))throw error;lastError=error}
    const remaining=deadline-now();if(remaining<=0)throw timeoutError(input,last,lastError);await sleepImpl(Math.min(poll,remaining));
  }
}
export const __test={timeoutError};
