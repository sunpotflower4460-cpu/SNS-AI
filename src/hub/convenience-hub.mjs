import crypto from 'node:crypto';

const HUB_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FORBIDDEN_SECRET_FIELDS = new Set(['token','accesstoken','refreshtoken','clientsecret','consumersecret','password','passwd','credential','credentials','apikey','api_key','privatekey','private_key']);
const SECRET_PATTERNS = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/
];

function hubError(message, code = 'HUB_CONFIG') { const error = new Error(message); error.code = code; error.publishStage = 'hub'; return error; }
function compareStable(a,b){ return a < b ? -1 : a > b ? 1 : 0; }
function canonicalize(value){ if(Array.isArray(value)) return value.map(canonicalize); if(value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>compareStable(a,b)).map(([k,v])=>[k,canonicalize(v)])); return value; }
export function stableStringify(value){ return JSON.stringify(canonicalize(value)); }
function mergeByKey(a,b,key){ const map = new Map((a||[]).map((x)=>[key(x),x])); for(const item of b||[]) map.set(key(item),item); return [...map.values()]; }
function reconcileStatus(existing,incoming){ if(incoming === 'archived') return 'archived'; if(existing === 'archived') return incoming === 'published' ? 'published' : 'archived'; if(existing === 'published') return 'published'; if(existing === 'ready' && incoming === 'staged') return 'ready'; return incoming; }
function clone(value){ return structuredClone(value); }
function assertHttps(url, label){ let parsed; try { parsed = new URL(url); } catch { throw hubError(`${label} must be a valid URL.`, 'HUB_VALIDATION'); } if(parsed.protocol !== 'https:' || parsed.username || parsed.password) throw hubError(`${label} must be credential-free https://.`, 'HUB_VALIDATION'); return parsed; }
function assertNoSecretMaterial(value, path='product'){
  if(value && typeof value === 'object'){
    for(const [key,child] of Object.entries(value)){
      if(FORBIDDEN_SECRET_FIELDS.has(key.toLowerCase())) throw hubError(`${path}.${key} looks like a credential field and cannot be written to SNS-HUB.`, 'HUB_SECRET');
      assertNoSecretMaterial(child, `${path}.${key}`);
    }
    return;
  }
  if(typeof value === 'string' && SECRET_PATTERNS.some((pattern)=>pattern.test(value))) throw hubError(`${path} contains high-confidence secret material.`, 'HUB_SECRET');
}
function validateProductShape(product,{requireReady=false}={}){
  if(!product || typeof product !== 'object') throw hubError('Hub product must be an object.','HUB_VALIDATION');
  if(!HUB_ID.test(String(product.productId||''))) throw hubError('Hub productId is invalid.','HUB_VALIDATION');
  if(!HUB_ID.test(String(product.slug||''))) throw hubError('Hub slug is invalid.','HUB_VALIDATION');
  if(product.schemaVersion !== 1) throw hubError('Hub schemaVersion must be 1.','HUB_VALIDATION');
  if(requireReady && product.publication?.status !== 'ready') throw hubError('SNS-AI must stage Hub products with publication.status=ready.','HUB_VALIDATION');
  assertHttps(product.officialUrl,'Hub officialUrl');
  assertNoSecretMaterial(product);
}
export function mergeCanonicalProduct(existing,incoming){
  validateProductShape(incoming);
  if(!existing) return clone(incoming);
  validateProductShape(existing);
  if(existing.productId !== incoming.productId) throw hubError('Hub productId mismatch.','HUB_CONFLICT');
  if(existing.slug !== incoming.slug) throw hubError(`Stable Hub slug mismatch: ${existing.slug} -> ${incoming.slug}`,'HUB_CONFLICT');
  const status = reconcileStatus(existing.publication?.status,incoming.publication?.status);
  return {
    ...clone(incoming),
    publication:{...clone(incoming.publication),status,firstPublishedAt:existing.publication?.firstPublishedAt ?? incoming.publication?.firstPublishedAt ?? null},
    routes:clone(incoming.routes || []),
    social:mergeByKey(existing.social||[],incoming.social||[],(x)=>`${x.platform}:${x.postId}`)
  };
}
export function hubConfig(env=process.env){
  const repository=String(env.CONVENIENCE_HUB_REPOSITORY||'').trim();
  const token=String(env.CONVENIENCE_HUB_GITHUB_TOKEN||'').trim();
  const branch=String(env.CONVENIENCE_HUB_BRANCH||'main').trim();
  const publicBaseUrl=String(env.CONVENIENCE_HUB_PUBLIC_URL||'').trim().replace(/\/+$/,'');
  if(!REPOSITORY.test(repository)) throw hubError('CONVENIENCE_HUB_REPOSITORY must be an explicit owner/repo.');
  if(!token) throw hubError('CONVENIENCE_HUB_GITHUB_TOKEN is required; generic GITHUB_TOKEN is intentionally not used.');
  if(!branch || /\s/.test(branch)) throw hubError('CONVENIENCE_HUB_BRANCH is invalid.');
  const parsed=assertHttps(publicBaseUrl,'CONVENIENCE_HUB_PUBLIC_URL');
  if(parsed.pathname !== '/' || parsed.search || parsed.hash) throw hubError('CONVENIENCE_HUB_PUBLIC_URL must be an origin-only URL.');
  return {repository,token,branch,publicBaseUrl:parsed.origin};
}
function githubHeaders(token){ return {Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'}; }
async function responseJson(response){ return response.json().catch(()=>({})); }
async function githubRequest(config,path,{fetchImpl=fetch,method='GET',body,allow404=false}={}){
  const response=await fetchImpl(`https://api.github.com/repos/${config.repository}${path}`,{method,headers:githubHeaders(config.token),body:body===undefined?undefined:JSON.stringify(body)});
  const data=await responseJson(response);
  if(allow404 && response.status===404) return null;
  if(!response.ok){const error=hubError(`SNS-HUB GitHub request failed (${response.status}): ${data?.message||'unknown error'}`,'HUB_GITHUB');error.status=response.status;throw error}
  return data;
}
function retryableWriteConflict(error){return [409,422].includes(Number(error?.status))}
function decodeContent(data,label){ if(!data || data.type==='dir' || typeof data.content!=='string') throw hubError(`${label} did not return a GitHub file payload.`,'HUB_GITHUB'); return Buffer.from(data.content.replace(/\n/g,''),data.encoding||'base64').toString('utf8'); }
async function readJsonFile(config,path,ref,{fetchImpl=fetch,allow404=false}={}){
  const data=await githubRequest(config,`/contents/${path}?ref=${encodeURIComponent(ref)}`,{fetchImpl,allow404});
  if(!data) return null;
  try { return {data:JSON.parse(decodeContent(data,path)),sha:data.sha}; } catch(error){ throw hubError(`SNS-HUB ${path} contains invalid JSON: ${error.message}`,'HUB_DATA'); }
}
export async function readHubProduct(productId,{env=process.env,fetchImpl=fetch,ref}={}){
  if(!HUB_ID.test(String(productId||''))) throw hubError('Hub productId is invalid.','HUB_VALIDATION');
  const config=hubConfig(env),targetRef=ref||config.branch;
  return readJsonFile(config,`data/products/${productId}.json`,targetRef,{fetchImpl,allow404:true});
}
async function writeHubProduct(product,{env=process.env,fetchImpl=fetch,message='hub: update canonical product'}={}){
  const config=hubConfig(env),path=`data/products/${product.productId}.json`;
  for(let attempt=1;attempt<=3;attempt+=1){
    const current=await readJsonFile(config,path,config.branch,{fetchImpl,allow404:true});
    const merged=mergeCanonicalProduct(current?.data||null,product);
    if(current && stableStringify(current.data)===stableStringify(merged)) return {changed:false,product:merged,ref:config.branch,blobSha:current.sha};
    const body={message,content:Buffer.from(`${JSON.stringify(merged,null,2)}\n`,'utf8').toString('base64'),branch:config.branch};
    if(current?.sha) body.sha=current.sha;
    try{
      const result=await githubRequest(config,`/contents/${path}`,{fetchImpl,method:'PUT',body});
      const commitSha=result?.commit?.sha;
      if(!commitSha) throw hubError('SNS-HUB write succeeded without a commit SHA.','HUB_GITHUB');
      return {changed:true,product:merged,ref:commitSha,commitSha,blobSha:result?.content?.sha||null};
    }catch(error){if(attempt<3&&retryableWriteConflict(error))continue;throw error}
  }
  throw hubError('SNS-HUB write conflict retry exhausted.','HUB_GITHUB');
}
async function readSnapshot(config,ref,{fetchImpl=fetch}={}){
  const [cats,probs,list]=await Promise.all([
    readJsonFile(config,'data/categories.json',ref,{fetchImpl}),
    readJsonFile(config,'data/problem-tags.json',ref,{fetchImpl}),
    githubRequest(config,`/contents/data/products?ref=${encodeURIComponent(ref)}`,{fetchImpl})
  ]);
  if(!Array.isArray(list)) throw hubError('SNS-HUB product directory listing is invalid.','HUB_DATA');
  const files=list.filter((item)=>item?.type==='file' && String(item.name||'').endsWith('.json')).sort((a,b)=>compareStable(a.name,b.name));
  const products=await Promise.all(files.map(async(item)=>(await readJsonFile(config,item.path,ref,{fetchImpl})).data));
  products.sort((a,b)=>compareStable(a.productId,b.productId));
  const categories=[...(cats?.data||[])].sort((a,b)=>compareStable(a.id,b.id));
  const problemTags=[...(probs?.data||[])].sort((a,b)=>compareStable(a.id,b.id));
  return {categories,problemTags,products};
}
export async function computeExpectedContentVersion({env=process.env,fetchImpl=fetch,ref}={}){
  const config=hubConfig(env),targetRef=ref||config.branch,snapshot=await readSnapshot(config,targetRef,{fetchImpl});
  return crypto.createHash('sha256').update(stableStringify(snapshot)).digest('hex').slice(0,20);
}
export async function stageHubProduct(product,{env=process.env,fetchImpl=fetch}={}){
  validateProductShape(product,{requireReady:true});
  const write=await writeHubProduct(product,{env,fetchImpl,message:`hub: stage ${product.productId}`});
  const expectedContentVersion=await computeExpectedContentVersion({env,fetchImpl,ref:write.ref});
  return {...write,expectedContentVersion};
}
function safeHealthUrl(config,path){ const url=new URL(path,`${config.publicBaseUrl}/`); if(url.origin!==config.publicBaseUrl) throw hubError('Hub health URL escaped configured origin.','HUB_SECURITY'); return url.toString(); }
async function healthJson(config,path,{fetchImpl=fetch}={}){
  const url=safeHealthUrl(config,path),response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json','Cache-Control':'no-cache'},redirect:'error'});
  const data=await responseJson(response);
  if(!response.ok) return {ok:false,status:response.status,url,data};
  return {ok:true,status:response.status,url,data};
}
export async function getHubReadiness({productId,expectedContentVersion},{env=process.env,fetchImpl=fetch}={}){
  if(!HUB_ID.test(String(productId||'')) || !/^[a-f0-9]{20}$/.test(String(expectedContentVersion||''))) throw hubError('Hub readiness input is invalid.','HUB_VALIDATION');
  const config=hubConfig(env);
  const manifest=await healthJson(config,'/_health/content-version',{fetchImpl});
  const product=await healthJson(config,`/_health/product/${encodeURIComponent(productId)}`,{fetchImpl});
  let publicUrlOk=false;
  if(product.ok && typeof product.data?.publicUrl==='string'){
    try { const u=new URL(product.data.publicUrl); publicUrlOk=u.origin===config.publicBaseUrl && /^\/p\/[a-z0-9][a-z0-9-]*$/.test(u.pathname); } catch { publicUrlOk=false; }
  }
  const ready=manifest.ok && product.ok && manifest.data?.contentVersion===expectedContentVersion && product.data?.contentVersion===expectedContentVersion && product.data?.productId===productId && product.data?.publishReady===true && product.data?.publiclyReachable===true && publicUrlOk;
  return {ready,manifest:manifest.data,product:product.data,checkedUrls:[manifest.url,product.url]};
}
export async function assertHubReady(input,options={}){ const result=await getHubReadiness(input,options); if(!result.ready){ const error=hubError(`SNS-HUB is not ready for ${input.productId} at expected contentVersion ${input.expectedContentVersion}.`,'HUB_NOT_READY'); error.readiness=result; throw error; } return result; }
export function attachBacklinkToProduct(product,backlink,updatedAt=new Date().toISOString()){
  validateProductShape(product);
  if(!['x','instagram'].includes(backlink?.platform) || !String(backlink?.postId||'').trim()) throw hubError('Hub social backlink platform/postId is invalid.','HUB_VALIDATION');
  assertHttps(backlink.url,'Hub social backlink URL');
  if(Number.isNaN(new Date(backlink.publishedAt).valueOf())) throw hubError('Hub social backlink publishedAt is invalid.','HUB_VALIDATION');
  if(product.publication?.status==='staged') throw hubError('Cannot attach a published social backlink before HUB_READY.','HUB_STATE');
  const key=`${backlink.platform}:${backlink.postId}`,current=(product.social||[]).find((x)=>`${x.platform}:${x.postId}`===key),transition=product.publication?.status==='ready';
  if(current && stableStringify(current)===stableStringify(backlink) && !transition) return {changed:false,product:clone(product)};
  return {changed:true,product:{...clone(product),social:mergeByKey(product.social||[],[clone(backlink)],(x)=>`${x.platform}:${x.postId}`),publication:{...clone(product.publication),status:transition?'published':product.publication.status,firstPublishedAt:transition?(product.publication.firstPublishedAt??backlink.publishedAt):product.publication.firstPublishedAt,updatedAt}}};
}
export async function attachHubSocialBacklink({productId,platform,postId,url,publishedAt},{env=process.env,fetchImpl=fetch,updatedAt=new Date().toISOString()}={}){
  const config=hubConfig(env),path=`data/products/${productId}.json`;
  for(let attempt=1;attempt<=3;attempt+=1){
    const current=await readJsonFile(config,path,config.branch,{fetchImpl,allow404:true});
    if(!current) throw hubError(`SNS-HUB product ${productId} does not exist.`,'HUB_STATE');
    const result=attachBacklinkToProduct(current.data,{platform,postId,url,publishedAt},updatedAt);
    if(!result.changed) return {changed:false,product:result.product,ref:config.branch};
    const body={message:`hub: attach ${platform} ${productId}`,content:Buffer.from(`${JSON.stringify(result.product,null,2)}\n`,'utf8').toString('base64'),branch:config.branch,sha:current.sha};
    try{
      const written=await githubRequest(config,`/contents/${path}`,{fetchImpl,method:'PUT',body});
      if(!written?.commit?.sha) throw hubError('SNS-HUB backlink write succeeded without a commit SHA.','HUB_GITHUB');
      return {changed:true,product:result.product,ref:written.commit.sha,commitSha:written.commit.sha};
    }catch(error){if(attempt<3&&retryableWriteConflict(error))continue;throw error}
  }
  throw hubError('SNS-HUB backlink write conflict retry exhausted.','HUB_GITHUB');
}
export const __test={canonicalize,mergeByKey,reconcileStatus,validateProductShape,assertNoSecretMaterial,safeHealthUrl,readSnapshot,retryableWriteConflict};