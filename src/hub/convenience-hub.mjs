import * as core from './convenience-hub-core.mjs';
import { validateHubProductContract, __test as contractTest } from './product-contract.mjs';

export const stableStringify=core.stableStringify;
export const hubConfig=core.hubConfig;
export const readHubProduct=core.readHubProduct;
export const computeExpectedContentVersion=core.computeExpectedContentVersion;
export const getHubReadiness=core.getHubReadiness;
export const assertHubReady=core.assertHubReady;

export function mergeCanonicalProduct(existing,incoming){
  validateHubProductContract(incoming);
  if(existing)validateHubProductContract(existing);
  return core.mergeCanonicalProduct(existing,incoming);
}

export async function stageHubProduct(product,options={}){
  validateHubProductContract(product,{requireReady:true});
  return core.stageHubProduct(product,options);
}

export function attachBacklinkToProduct(product,backlink,updatedAt){
  validateHubProductContract(product);
  return core.attachBacklinkToProduct(product,backlink,updatedAt);
}

export async function attachHubSocialBacklink(input,options={}){
  return core.attachHubSocialBacklink(input,options);
}

export const __test={...core.__test,contract:contractTest,validateHubProductContract};
