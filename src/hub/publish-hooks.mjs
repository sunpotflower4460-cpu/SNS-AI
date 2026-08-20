import { assertHubReady, attachHubSocialBacklink } from './convenience-hub.mjs';

const HUB_INTEGRATION = 'convenience-discovery-v1';
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const VERSION = /^[a-f0-9]{20}$/;

function hookError(message, code='HUB_VALIDATION'){const error=new Error(message);error.code=code;error.publishStage='hub';return error}
function safeHttps(value,label){let url;try{url=new URL(value)}catch{throw hookError(`${label} is invalid.`)}if(url.protocol!=='https:'||url.username||url.password)throw hookError(`${label} must be credential-free https://.`);return url}
export function hubRequirement(payloadOrHub,claim=null){
  const supplied=payloadOrHub?.hub ?? payloadOrHub;
  const candidate=supplied?.required===true ? supplied : claim?.hub?.required===true ? claim.hub : null;
  if(!candidate)return null;
  if(candidate.integration!==HUB_INTEGRATION)throw hookError(`Hub integration must be ${HUB_INTEGRATION}.`);
  if(!ID.test(String(candidate.productId||'')))throw hookError('Hub productId is invalid.');
  if(!VERSION.test(String(candidate.expectedContentVersion||'')))throw hookError('Hub expectedContentVersion is invalid.');
  return {required:true,integration:HUB_INTEGRATION,productId:candidate.productId,expectedContentVersion:candidate.expectedContentVersion};
}
export async function assertHubBeforeProvider(payload,{claim=null,assertReady=assertHubReady,env=process.env,fetchImpl=fetch}={}){
  const requirement=hubRequirement(payload,claim);if(!requirement)return {skipped:true};
  const readiness=await assertReady({productId:requirement.productId,expectedContentVersion:requirement.expectedContentVersion},{env,fetchImpl});
  return {skipped:false,requirement,readiness};
}
async function instagramPermalink(account,postId,{fetchImpl=fetch}={}){
  if(!account?.credential?.accessToken)throw hookError('Instagram credential is unavailable for permalink reconciliation.','HUB_BACKLINK_PENDING');
  const version=String(account.apiVersion||'v25.0');
  if(!/^v\d+\.\d+$/.test(version))throw hookError('Instagram API version is invalid.','HUB_BACKLINK_PENDING');
  const response=await fetchImpl(`https://graph.instagram.com/${version}/${encodeURIComponent(postId)}?fields=permalink`,{method:'GET',headers:{Authorization:`Bearer ${account.credential.accessToken}`,Accept:'application/json'},redirect:'error'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||typeof data?.permalink!=='string')throw hookError(`Instagram permalink lookup failed (${response.status}).`,'HUB_BACKLINK_PENDING');
  const url=safeHttps(data.permalink,'Instagram permalink');
  if(!/(^|\.)instagram\.com$/i.test(url.hostname))throw hookError('Instagram permalink host is unexpected.','HUB_BACKLINK_PENDING');
  return url.toString();
}
export async function publishedPostUrl({account,postId,result},{fetchImpl=fetch}={}){
  if(!postId)throw hookError('Provider post ID is required for Hub backlink reconciliation.','HUB_BACKLINK_PENDING');
  const supplied=result?.postUrl||result?.permalink||result?.raw?.permalink;
  if(supplied)return safeHttps(supplied,'Provider post URL').toString();
  if(account?.platform==='x')return `https://x.com/i/web/status/${encodeURIComponent(postId)}`;
  if(account?.platform==='instagram')return instagramPermalink(account,postId,{fetchImpl});
  throw hookError(`Unsupported Hub backlink platform: ${account?.platform||'unknown'}.`,'HUB_BACKLINK_PENDING');
}
export async function syncPublishedHubBacklink({payload,account,claim=null,postId,publishedAt,result=null},{attach=attachHubSocialBacklink,env=process.env,fetchImpl=fetch,updatedAt}={}){
  const requirement=hubRequirement(payload,claim);if(!requirement)return {skipped:true};
  const effectivePostId=postId||claim?.providerPostId||null,effectivePublishedAt=publishedAt||claim?.publishedAt||claim?.updatedAt||null;
  if(!effectivePostId||!effectivePublishedAt)throw hookError('Published claim lacks postId/publishedAt required for Hub backlink.','HUB_BACKLINK_PENDING');
  const url=await publishedPostUrl({account,postId:effectivePostId,result},{fetchImpl});
  const sync=await attach({productId:requirement.productId,platform:account.platform,postId:String(effectivePostId),url,publishedAt:effectivePublishedAt},{env,fetchImpl,updatedAt});
  return {skipped:false,requirement,url,sync};
}
export const __test={instagramPermalink,safeHttps,HUB_INTEGRATION};
