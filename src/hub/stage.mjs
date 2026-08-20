import { readFile, writeFile } from 'node:fs/promises';
import { stageHubProduct } from './convenience-hub.mjs';
import { waitForHubReady } from './readiness.mjs';

function parseArgs(argv){const args={};for(let i=0;i<argv.length;i+=1){const token=argv[i];if(!token.startsWith('--'))continue;const key=token.slice(2),next=argv[i+1];if(!next||next.startsWith('--'))args[key]=true;else{args[key]=next;i+=1}}return args}
function bool(value){return value===true||['1','true','yes','on'].includes(String(value??'').toLowerCase())}
export async function stageFromFile(file,{wait=false,timeoutSeconds=600,pollSeconds=5,output,stage=stageHubProduct,waitReady=waitForHubReady}={}){
  if(!file)throw new Error('hub:stage requires --file <canonical-product.json>.');
  const product=JSON.parse(await readFile(file,'utf8'));
  const staged=await stage(product),hub={required:true,integration:'convenience-discovery-v1',productId:product.productId,expectedContentVersion:staged.expectedContentVersion};
  let readiness=null;if(wait)readiness=await waitReady({productId:hub.productId,expectedContentVersion:hub.expectedContentVersion},{timeoutMs:Number(timeoutSeconds)*1000,pollMs:Number(pollSeconds)*1000});
  const result={ok:true,productId:product.productId,commitSha:staged.commitSha||null,changed:Boolean(staged.changed),hub,ready:Boolean(readiness?.ready),publicUrl:readiness?.product?.publicUrl||null};
  if(output)await writeFile(output,`${JSON.stringify(result,null,2)}\n`,'utf8');
  return result;
}
if(import.meta.url===`file://${process.argv[1]}`){try{const args=parseArgs(process.argv.slice(2)),result=await stageFromFile(args.file,{wait:bool(args.wait),timeoutSeconds:args['timeout-seconds']||600,pollSeconds:args['poll-seconds']||5,output:args.output});console.log(JSON.stringify(result,null,2))}catch(error){console.error(JSON.stringify({ok:false,error:error.message,code:error.code||null},null,2));process.exitCode=1}}
export const __test={parseArgs,bool};
