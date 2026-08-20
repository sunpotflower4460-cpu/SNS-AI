const ID=/^[a-z0-9][a-z0-9-]*$/;
const TOP_KEYS=['schemaVersion','productId','slug','name','brand','kind','categoryIds','problemTagIds','problemSolved','convenienceInOneSentence','whyInteresting','whoFor','whoCanSkip','tradeoffs','officialUrl','media','pricing','availability','scores','routes','alternatives','social','freshness','publication'];
const KINDS=new Set(['physical','service','app','subscription','free-tool']);
const AVAILABILITY=new Set(['available','limited','unknown','unavailable','discontinued']);
const RIGHTS=new Set(['affiliate-creative','explicitly-permitted','owned','unknown']);
const SCORE_KEYS=['discoverySurprise','practicalUtility','clarity','evidenceStrength','audienceFit','valueSense','distinctiveness','shareability','risk'];
const PROVIDERS=new Set(['amazon','rakuten','a8','valuecommerce','impact','direct','other']);
const ROUTE_TYPES=new Set(['affiliate','official','non-affiliate']);
const ROUTE_PLATFORMS=new Set(['hub','x','instagram']);
const ROUTE_STATUSES=new Set(['ACTIVE','DEGRADED','REVERIFY_DUE','PROGRAM_PAUSED','DISABLED']);
const ALT_RELATIONS=new Set(['similar','cheaper','current-alternative','different-use-case']);
const PUBLICATION_STATUSES=new Set(['staged','ready','published','archived']);
const SOCIAL_PLATFORMS=new Set(['x','instagram']);

function contractError(message){const error=new Error(`SNS-HUB product contract: ${message}`);error.code='HUB_VALIDATION';error.publishStage='hub';return error}
function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw contractError(`${label} must be an object.`);return value}
function exactKeys(value,keys,label){object(value,label);const allowed=new Set(keys),actual=Object.keys(value);for(const key of keys)if(!Object.hasOwn(value,key))throw contractError(`${label}.${key} is required.`);for(const key of actual)if(!allowed.has(key))throw contractError(`${label}.${key} is not allowed.`)}
function text(value,label){if(typeof value!=='string'||!value.trim())throw contractError(`${label} must be a non-empty string.`);return value}
function id(value,label){text(value,label);if(!ID.test(value))throw contractError(`${label} must be a stable lowercase id.`);return value}
function oneOf(value,set,label){if(!set.has(value))throw contractError(`${label} is invalid.`);return value}
function bool(value,label){if(typeof value!=='boolean')throw contractError(`${label} must be boolean.`)}
function dateTime(value,label,{nullable=false}={}){if(nullable&&value===null)return;if(typeof value!=='string'||!value.includes('T')||Number.isNaN(new Date(value).valueOf()))throw contractError(`${label} must be ISO-8601 date-time${nullable?' or null':''}.`)}
function https(value,label){text(value,label);let url;try{url=new URL(value)}catch{throw contractError(`${label} must be a valid URL.`)}if(url.protocol!=='https:'||url.username||url.password)throw contractError(`${label} must be credential-free https://.`)}
function array(value,label,{min=0}={}){if(!Array.isArray(value)||value.length<min)throw contractError(`${label} must be an array with at least ${min} item(s).`);return value}
function unique(values,label,key=(x)=>x){const seen=new Set();for(const value of values){const k=key(value);if(seen.has(k))throw contractError(`${label} contains duplicate ${k}.`);seen.add(k)}}
function idArray(value,label){const rows=array(value,label,{min:1});for(const [i,row] of rows.entries())id(row,`${label}[${i}]`);unique(rows,label);return rows}
function textArray(value,label){const rows=array(value,label,{min:1});for(const [i,row] of rows.entries())text(row,`${label}[${i}]`);return rows}

export function validateHubProductContract(product,{requireReady=false}={}){
  exactKeys(product,TOP_KEYS,'product');
  if(product.schemaVersion!==1)throw contractError('product.schemaVersion must be 1.');
  id(product.productId,'product.productId');id(product.slug,'product.slug');
  text(product.name,'product.name');text(product.brand,'product.brand');oneOf(product.kind,KINDS,'product.kind');
  idArray(product.categoryIds,'product.categoryIds');idArray(product.problemTagIds,'product.problemTagIds');
  text(product.problemSolved,'product.problemSolved');text(product.convenienceInOneSentence,'product.convenienceInOneSentence');text(product.whyInteresting,'product.whyInteresting');
  textArray(product.whoFor,'product.whoFor');textArray(product.whoCanSkip,'product.whoCanSkip');textArray(product.tradeoffs,'product.tradeoffs');https(product.officialUrl,'product.officialUrl');

  for(const [i,media] of array(product.media,'product.media').entries()){
    exactKeys(media,['url','alt','rightsStatus'],`product.media[${i}]`);https(media.url,`product.media[${i}].url`);text(media.alt,`product.media[${i}].alt`);oneOf(media.rightsStatus,RIGHTS,`product.media[${i}].rightsStatus`);
  }

  exactKeys(product.pricing,['display','currency','verifiedAt'],'product.pricing');
  if(product.pricing.display!==null)text(product.pricing.display,'product.pricing.display');
  if(product.pricing.currency!=='JPY')throw contractError('product.pricing.currency must be JPY.');
  dateTime(product.pricing.verifiedAt,'product.pricing.verifiedAt',{nullable:true});
  if(product.pricing.display!==null&&product.pricing.verifiedAt===null)throw contractError('exact product.pricing.display requires verifiedAt.');
  oneOf(product.availability,AVAILABILITY,'product.availability');

  exactKeys(product.scores,SCORE_KEYS,'product.scores');
  for(const key of SCORE_KEYS){const value=product.scores[key];if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100)throw contractError(`product.scores.${key} must be 0..100.`)}

  const routeIds=[];
  for(const [i,route] of array(product.routes,'product.routes').entries()){
    const label=`product.routes[${i}]`;exactKeys(route,['routeId','provider','merchant','url','routeType','platforms','status','destinationProductMatch','verifiedAt','disclosureRequired','notes'],label);
    id(route.routeId,`${label}.routeId`);routeIds.push(route.routeId);oneOf(route.provider,PROVIDERS,`${label}.provider`);text(route.merchant,`${label}.merchant`);https(route.url,`${label}.url`);oneOf(route.routeType,ROUTE_TYPES,`${label}.routeType`);
    const platforms=array(route.platforms,`${label}.platforms`,{min:1});for(const p of platforms)oneOf(p,ROUTE_PLATFORMS,`${label}.platforms`);unique(platforms,`${label}.platforms`);
    oneOf(route.status,ROUTE_STATUSES,`${label}.status`);bool(route.destinationProductMatch,`${label}.destinationProductMatch`);dateTime(route.verifiedAt,`${label}.verifiedAt`);bool(route.disclosureRequired,`${label}.disclosureRequired`);
    if(route.notes!==null&&typeof route.notes!=='string')throw contractError(`${label}.notes must be string or null.`);
    if(route.routeType==='affiliate'&&route.disclosureRequired!==true)throw contractError(`${label} affiliate route must require disclosure.`);
    if(route.status==='ACTIVE'&&route.destinationProductMatch!==true)throw contractError(`${label} ACTIVE route must match the exact product.`);
  }
  unique(routeIds,'product.routes');

  for(const [i,alt] of array(product.alternatives,'product.alternatives').entries()){
    const label=`product.alternatives[${i}]`;exactKeys(alt,['productId','relation','reason','verifiedAt'],label);id(alt.productId,`${label}.productId`);if(alt.productId===product.productId)throw contractError(`${label} cannot reference itself.`);oneOf(alt.relation,ALT_RELATIONS,`${label}.relation`);text(alt.reason,`${label}.reason`);dateTime(alt.verifiedAt,`${label}.verifiedAt`);
  }

  const socialKeys=[];
  for(const [i,social] of array(product.social,'product.social').entries()){
    const label=`product.social[${i}]`;exactKeys(social,['platform','postId','url','publishedAt'],label);oneOf(social.platform,SOCIAL_PLATFORMS,`${label}.platform`);text(social.postId,`${label}.postId`);https(social.url,`${label}.url`);dateTime(social.publishedAt,`${label}.publishedAt`);socialKeys.push(`${social.platform}:${social.postId}`);
  }
  unique(socialKeys,'product.social');

  exactKeys(product.freshness,['lastProductVerifiedAt','lastPriceVerifiedAt','lastAffiliateRouteVerifiedAt'],'product.freshness');
  dateTime(product.freshness.lastProductVerifiedAt,'product.freshness.lastProductVerifiedAt',{nullable:true});dateTime(product.freshness.lastPriceVerifiedAt,'product.freshness.lastPriceVerifiedAt',{nullable:true});dateTime(product.freshness.lastAffiliateRouteVerifiedAt,'product.freshness.lastAffiliateRouteVerifiedAt',{nullable:true});
  exactKeys(product.publication,['status','firstPublishedAt','updatedAt'],'product.publication');oneOf(product.publication.status,PUBLICATION_STATUSES,'product.publication.status');dateTime(product.publication.firstPublishedAt,'product.publication.firstPublishedAt',{nullable:true});dateTime(product.publication.updatedAt,'product.publication.updatedAt',{nullable:true});
  if(requireReady&&product.publication.status!=='ready')throw contractError('SNS-AI staging requires product.publication.status=ready.');
  if(requireReady&&product.social.length)throw contractError('SNS-AI staging input must not contain already-published social backlinks; Hub preserves existing backlinks during merge.');
  return product;
}

export const __test={TOP_KEYS,SCORE_KEYS,contractError};
