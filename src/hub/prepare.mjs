import { stageHubProduct } from './convenience-hub.mjs';
import { waitForHubReady } from './readiness.mjs';

export async function prepareHubPublish(product,{stage=stageHubProduct,waitReady=waitForHubReady,timeoutMs=10*60_000,pollMs=5_000}={}){
  const staged=await stage(product);
  const hub={required:true,integration:'convenience-discovery-v1',productId:product.productId,expectedContentVersion:staged.expectedContentVersion};
  const readiness=await waitReady({productId:hub.productId,expectedContentVersion:hub.expectedContentVersion},{timeoutMs,pollMs});
  return{hub,staged,readiness};
}
