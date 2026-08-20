import { assertHubReady } from './convenience-hub.mjs';

const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
export async function waitForHubReady(input,{attempts=18,delayMs=10000,assertReady=assertHubReady,sleepImpl=sleep,...options}={}){
  let last;
  for(let attempt=1;attempt<=attempts;attempt+=1){
    try{return await assertReady(input,options)}catch(error){
      last=error;
      if(error?.code!=='HUB_NOT_READY')throw error;
      if(attempt<attempts)await sleepImpl(delayMs);
    }
  }
  throw last;
}
