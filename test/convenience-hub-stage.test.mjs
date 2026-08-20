import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageFromFile} from '../src/hub/stage.mjs';
test('stage command emits versioned publish envelope and can wait for deployment',async()=>{const dir=await mkdtemp(join(tmpdir(),'hub-stage-'));try{const file=join(dir,'p.json'),output=join(dir,'out.json');await writeFile(file,JSON.stringify({productId:'p1'}));let waited=null;const result=await stageFromFile(file,{wait:true,output,stage:async()=>({changed:true,commitSha:'abc',expectedContentVersion:'aaaaaaaaaaaaaaaaaaaa'}),waitReady:async(input)=>{waited=input;return{ready:true,product:{publicUrl:'https://hub.example/p/p1'}}}});assert.deepEqual(result.hub,{required:true,integration:'convenience-discovery-v1',productId:'p1',expectedContentVersion:'aaaaaaaaaaaaaaaaaaaa'});assert.equal(result.ready,true);assert.deepEqual(waited,{productId:'p1',expectedContentVersion:'aaaaaaaaaaaaaaaaaaaa'});assert.equal(JSON.parse(await readFile(output,'utf8')).commitSha,'abc')}finally{await rm(dir,{recursive:true,force:true})}});
