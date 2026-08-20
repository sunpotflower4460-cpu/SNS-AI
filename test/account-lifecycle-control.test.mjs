import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertPostingProfileCompliance, autoPromotionEvidence, patchAccountLifecycle } from '../src/ops/account-control.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const confirmedPolicy = { xAutomationProfileComplianceConfirmedAccounts: ['alpha'] };
function fixture(mode='approval',enabled=true){return{defaults:{mode:'pause'},accounts:{alpha:{platform:'x',enabled,mode},beta:{platform:'instagram',enabled:false,mode:'pause'}}}}
function history(){return[{account:'alpha',status:'published',providerPostId:'post-1',at:'2026-08-20T00:00:00Z'}]}
function metrics(){return[{account:'alpha',providerPostId:'post-1',collectedAt:'2026-08-20T01:00:00Z',impressions:100}]}

test('approval enables only the selected account and preserves other config',()=>{
  const input=fixture('pause',false);
  const result=patchAccountLifecycle({accountsConfig:input,policy:confirmedPolicy,accountId:'alpha',target:'approval'});
  assert.equal(result.accountsConfig.accounts.alpha.enabled,true);
  assert.equal(result.accountsConfig.accounts.alpha.mode,'approval');
  assert.equal(result.accountsConfig.accounts.beta.enabled,false);
  assert.equal(input.accounts.alpha.enabled,false,'input must not be mutated');
});

test('X live publishing modes fail closed until automated-profile compliance is recorded',()=>{
  assert.throws(()=>assertPostingProfileCompliance({accountId:'alpha',account:{platform:'x'},policy:{}}),error=>error.code==='ACCOUNT_X_PROFILE_COMPLIANCE_REQUIRED');
  assert.equal(assertPostingProfileCompliance({accountId:'alpha',account:{platform:'x'},policy:confirmedPolicy}),true);
  assert.equal(assertPostingProfileCompliance({accountId:'beta',account:{platform:'instagram'},policy:{}}),true);
});

test('auto promotion requires approval mode, a controlled publish, and matching metrics',()=>{
  assert.throws(()=>autoPromotionEvidence({accountId:'alpha',account:{enabled:false,mode:'approval'},history:history(),metrics:metrics()}),error=>error.code==='ACCOUNT_AUTO_REQUIRES_APPROVAL_MODE');
  assert.throws(()=>autoPromotionEvidence({accountId:'alpha',account:{enabled:true,mode:'approval'},history:[],metrics:metrics()}),error=>error.code==='ACCOUNT_AUTO_PUBLISHED_PROOF_REQUIRED');
  assert.throws(()=>autoPromotionEvidence({accountId:'alpha',account:{enabled:true,mode:'approval'},history:history(),metrics:[]}),error=>error.code==='ACCOUNT_AUTO_METRICS_PROOF_REQUIRED');
  const evidence=autoPromotionEvidence({accountId:'alpha',account:{enabled:true,mode:'approval'},history:history(),metrics:metrics()});
  assert.equal(evidence.publishedCount,1);
  assert.equal(evidence.metricSnapshotCount,1);
  assert.equal(evidence.latestProviderPostId,'post-1');
});

test('auto promotion changes state only when every local proof is present',()=>{
  const result=patchAccountLifecycle({accountsConfig:fixture(),policy:confirmedPolicy,accountId:'alpha',target:'auto',history:history(),metrics:metrics()});
  assert.equal(result.accountsConfig.accounts.alpha.enabled,true);
  assert.equal(result.accountsConfig.accounts.alpha.mode,'auto');
  assert.equal(result.evidence.latestProviderPostId,'post-1');
});

test('pause and disabled are unconditional safety transitions',()=>{
  const paused=patchAccountLifecycle({accountsConfig:fixture('auto',true),policy:{},accountId:'alpha',target:'pause'});
  assert.equal(paused.accountsConfig.accounts.alpha.enabled,true);
  assert.equal(paused.accountsConfig.accounts.alpha.mode,'pause');
  const disabled=patchAccountLifecycle({accountsConfig:fixture('auto',true),policy:{},accountId:'alpha',target:'disabled'});
  assert.equal(disabled.accountsConfig.accounts.alpha.enabled,false);
  assert.equal(disabled.accountsConfig.accounts.alpha.mode,'pause');
});

test('unknown accounts and lifecycle targets are rejected',()=>{
  assert.throws(()=>patchAccountLifecycle({accountsConfig:fixture(),policy:{},accountId:'missing',target:'pause'}),error=>error.code==='ACCOUNT_UNKNOWN');
  assert.throws(()=>patchAccountLifecycle({accountsConfig:fixture(),policy:{},accountId:'alpha',target:'launch'}),error=>error.code==='ACCOUNT_TARGET_INVALID');
  assert.throws(()=>patchAccountLifecycle({accountsConfig:fixture(),policy:{},accountId:'bad id',target:'pause'}),error=>error.code==='ACCOUNT_ID_INVALID');
});

test('account control workflow exposes bounded ChatGPT-safe lifecycle commands',async()=>{
  const workflow=await readFile(`${ROOT}.github/workflows/account-control.yml`,'utf8');
  assert.match(workflow,/\[account-approval\]/);
  assert.match(workflow,/\[account-auto\]/);
  assert.match(workflow,/\[account-pause\]/);
  assert.match(workflow,/\[account-disable\]/);
  assert.match(workflow,/steps\.command\.outputs\.target == 'auto'/);
  assert.match(workflow,/live-preflight\.mjs --account/);
  assert.match(workflow,/open \[health\] incident/);
  assert.match(workflow,/git push origin HEAD:main/);
  assert.doesNotMatch(workflow,/cancel-in-progress:\s*true/);
});
