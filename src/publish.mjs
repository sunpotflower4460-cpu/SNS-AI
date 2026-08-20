import { readFile } from 'node:fs/promises';
import { resolveAccount } from './lib/config.mjs';
import { appendAudit } from './lib/audit.mjs';
import { getDurableClaim, writeDurableClaim } from './lib/durable-claim.mjs';
import { publish as corePublish, __test as coreTest } from './publish-core.mjs';
import { assertHubBeforeProvider, hubRequirement, syncPublishedHubBacklink } from './hub/publish-hooks.mjs';
import { prepareHubPublish } from './hub/prepare.mjs';
import { validateHubProductContract } from './hub/product-contract.mjs';

const HANDLED = new Set(['publishing','publish_unknown','published']);
const sleep = (ms) => new Promise((resolve)=>setTimeout(resolve,ms));
function boolValue(value){return value===true||['true','1','yes','on'].includes(String(value??'').trim().toLowerCase())}
function parseArgs(argv){const args={};for(let i=0;i<argv.length;i+=1){const token=argv[i];if(!token.startsWith('--'))continue;const key=token.slice(2),next=argv[i+1];if(!next||next.startsWith('--'))args[key]=true;else{args[key]=next;i+=1}}return args}
async function loadPayload(args){if(args.file)return JSON.parse(await readFile(args.file,'utf8'));if(args.json)return JSON.parse(args.json);return{account:args.account,text:args.text||'',mediaUrl:args['media-url'],mediaType:args['media-type']||'image',mediaAltText:args['media-alt-text']||'',dryRun:boolValue(args['dry-run']),source:args.source||'manual',slotId:args['slot-id']}}
function pendingError(error,result){const wrapped=new Error(`Social post succeeded but SNS-HUB backlink reconciliation is pending: ${error?.message||error}`);wrapped.code='HUB_BACKLINK_PENDING';wrapped.publishStage='hub-backlink';wrapped.providerResult=result;wrapped.cause=error;wrapped.bookkeepingWarnings=[...(result?.bookkeepingWarnings||[]),{label:'hub-social-backlink',error:String(error?.message||error).slice(0,500)}];return wrapped}
function durablePendingError(error,result){const wrapped=new Error(`Social post succeeded but its durable published claim could not be confirmed: ${error?.message||error}`);wrapped.code='HUB_DURABLE_PENDING';wrapped.publishStage='hub-durable';wrapped.providerResult=result;wrapped.cause=error;wrapped.bookkeepingWarnings=[...(result?.bookkeepingWarnings||[]),{label:'hub-durable-published-claim',error:String(error?.message||error).slice(0,500)}];return wrapped}
async function syncWithRetry(context,{sync=syncPublishedHubBacklink,attempts=3,sleepImpl=sleep}={}){let last;for(let attempt=1;attempt<=attempts;attempt+=1){try{return await sync(context)}catch(error){last=error;if(attempt<attempts)await sleepImpl(attempt*250)}}throw last}
function withoutHubProduct(payload){if(!payload||typeof payload!=='object'||!Object.hasOwn(payload,'hubProduct'))return payload;const {hubProduct:_hubProduct,...rest}=payload;return rest}
function claimHasRequirement(claim,requirement){return claim?.hub?.required===true&&claim.hub.integration===requirement.integration&&claim.hub.productId===requirement.productId&&claim.hub.expectedContentVersion===requirement.expectedContentVersion}
async function ensurePublishedHubClaim({slotId,claim,requirement,postId,publishedAt,payload,account},{writeClaim=writeDurableClaim,sleepImpl=sleep,attempts=3}={}){
  if(claim?.status==='published'&&claimHasRequirement(claim,requirement)&&(!postId||claim.providerPostId===postId))return claim;
  let last;
  const detail={hub:requirement,account:payload.account,platform:account.platform,source:payload.source||'manual',providerPostId:postId||claim?.providerPostId||null,publishedAt:claim?.publishedAt||publishedAt};
  for(let attempt=1;attempt<=attempts;attempt+=1){try{return await writeClaim(slotId,'published',detail)}catch(error){last=error;if(attempt<attempts)await sleepImpl(attempt*250)}}
  throw last;
}
async function markHubBacklinkSynced({slotId,claim,requirement,hubSync},{writeClaim=writeDurableClaim,now=()=>new Date()}={}){
  const syncedAt=now().toISOString();
  return writeClaim(slotId,'published',{hub:requirement,providerPostId:claim?.providerPostId||null,publishedAt:claim?.publishedAt||null,hubBacklinkSyncedAt:syncedAt,hubBacklinkUrl:hubSync?.url||null});
}

export async function publish(payload,{
  core=corePublish,
  getClaim=getDurableClaim,
  writeClaim=writeDurableClaim,
  assertBefore=assertHubBeforeProvider,
  syncBacklink=syncPublishedHubBacklink,
  resolve=resolveAccount,
  audit=appendAudit,
  sleepImpl=sleep,
  prepare=prepareHubPublish,
  validateProduct=validateHubProductContract,
  now=()=>new Date()
}={}){
  const dryRun=boolValue(payload?.dryRun),slotId=payload?.slotId||null;
  const explicitHub=payload?.hub?.required===true,hasHubProduct=Boolean(payload?.hubProduct);
  if(!explicitHub&&!hasHubProduct&&(!slotId||dryRun))return core(payload);
  if(dryRun){
    if(hasHubProduct)validateProduct(payload.hubProduct,{requireReady:true});
    if(explicitHub)hubRequirement(payload,null);
    return core(withoutHubProduct(payload));
  }

  let claim=slotId?await getClaim(slotId,{fresh:true}):null;
  let effectivePayload=payload;
  let requirement=hubRequirement(payload,claim);
  if(!requirement&&hasHubProduct){
    const prepared=await prepare(payload.hubProduct);
    effectivePayload={...withoutHubProduct(payload),hub:prepared.hub};
    requirement=hubRequirement(effectivePayload,claim);
  }
  if(!requirement)return core(withoutHubProduct(payload));
  if(!slotId){const error=new Error('Hub-dependent live publishing requires slotId for durable recovery.');error.code='HUB_SLOT_REQUIRED';error.publishStage='hub';throw error}

  effectivePayload=withoutHubProduct(effectivePayload);
  if(!HANDLED.has(claim?.status)){
    await assertBefore(effectivePayload,{claim});
    const preparedStatus=claim?.status||'hub_ready';
    claim=await writeClaim(slotId,preparedStatus,{hub:requirement});
  }

  const result=await core(effectivePayload);
  let finalClaim=(await getClaim(slotId,{fresh:true}))||claim;
  const account=await resolve(payload.account);
  const postId=result?.postId||finalClaim?.providerPostId||null;
  const publishedAt=finalClaim?.publishedAt||claim?.publishedAt||now().toISOString();
  try{
    finalClaim=await ensurePublishedHubClaim({slotId,claim:finalClaim,requirement,postId,publishedAt,payload:effectivePayload,account},{writeClaim,sleepImpl});
  }catch(error){
    const pending=durablePendingError(error,result);
    await audit({account:payload.account,stage:'hub-durable-pending',slotId,platform:account.platform,providerPostId:postId,hubProductId:requirement.productId,error:String(error?.message||error).slice(0,500)}).catch(()=>{});
    throw pending;
  }

  let hubSync;
  try{
    hubSync=await syncWithRetry({payload:effectivePayload,account,claim:finalClaim,postId,publishedAt:finalClaim.publishedAt||publishedAt,result},{sync:syncBacklink,sleepImpl});
  }catch(error){
    const pending=pendingError(error,result);
    await audit({account:payload.account,stage:'hub-backlink-pending',slotId,platform:account.platform,providerPostId:postId,hubProductId:requirement.productId,error:String(error?.message||error).slice(0,500)}).catch(()=>{});
    throw pending;
  }

  let markerPersisted=true;
  try{
    finalClaim=await markHubBacklinkSynced({slotId,claim:finalClaim,requirement,hubSync},{writeClaim,now});
  }catch(error){
    markerPersisted=false;
    await audit({account:payload.account,stage:'hub-backlink-marker-pending',slotId,platform:account.platform,providerPostId:postId,hubProductId:requirement.productId,error:String(error?.message||error).slice(0,500)}).catch(()=>{});
  }
  await audit({account:payload.account,stage:'hub-backlink-synced',slotId,platform:account.platform,providerPostId:postId,hubProductId:requirement.productId,hubChanged:Boolean(hubSync?.sync?.changed),markerPersisted}).catch(()=>{});
  return {...result,hub:{productId:requirement.productId,synced:true,changed:Boolean(hubSync?.sync?.changed),markerPersisted}};
}

if(import.meta.url===`file://${process.argv[1]}`){
  try{const payload=await loadPayload(parseArgs(process.argv.slice(2)));const result=await publish(payload);console.log(JSON.stringify({ok:true,account:payload.account,result},null,2))}
  catch(error){console.error(JSON.stringify({ok:false,error:error.message,status:error.status,code:error.code,bookkeepingWarnings:error.bookkeepingWarnings||[]},null,2));process.exitCode=1}
}
export const __test={...coreTest,boolValue,parseArgs,pendingError,durablePendingError,syncWithRetry,withoutHubProduct,claimHasRequirement,ensurePublishedHubClaim,markHubBacklinkSynced};
