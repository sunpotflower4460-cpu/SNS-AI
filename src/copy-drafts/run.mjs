// Copy-draft generation step: one brief -> one OpenAI Responses call -> data/copy-drafts/<date>-<slug>.json.
// GENERATION AND FILE SAVE ONLY. This module must never import or call any publish/post provider.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openaiRequest, outputText, parseJsonText } from '../lib/openai.mjs';
import { localDateKey } from '../lib/schedule.mjs';
import { loadBudgetSnapshot, preflightPaidGeneration } from '../budget/preflight.mjs';
import { constrainRouteForBudget } from '../ai/router.mjs';
import { briefSlug, parseBrief } from './brief.mjs';
import { buildSystemPrompt, buildUserPrompt, variantsSchema } from './prompt.mjs';
import { checkVariants } from './quality.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_OUT_DIR = join(ROOT, 'data/copy-drafts');
const CONFIG_FILE = join(ROOT, 'config/copy-drafts.json');
const FORBIDDEN_MODEL = /astra|gpt-5\.6/i;

function assertAllowedModel(config, model) {
  if (!config.models?.allowed?.includes(model) || FORBIDDEN_MODEL.test(String(model))) throw new Error(`Model "${model}" is not allowed for copy drafts.`);
}

export async function loadCopyDraftConfig(file = CONFIG_FILE) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  for (const model of [config.models?.standard, config.models?.hard, ...(config.models?.allowed || [])]) assertAllowedModel(config, model);
  return config;
}

// The pseudo "account" gives the existing daily counter (src/ops/budget.mjs) a stable key and limit, so
// copy-draft calls are counted and capped exactly like every other OpenAI call in this repository.
function budgetAccount(config) {
  return { schedule: { timezone: 'Asia/Tokyo' }, budgets: { ...config.budgets }, ai: { openaiTriageModel: config.models.standard } };
}

export function chooseModel(config, { hard = false, budgetState = 'healthy' } = {}) {
  const wanted = hard
    ? { tier: 'high', provider: 'openai', model: config.models.hard }
    : { tier: 'balanced', provider: 'openai', model: config.models.standard };
  // Same downgrade rule as the router: conservative/critical budget states never use the high tier.
  const route = constrainRouteForBudget(wanted, budgetState, budgetAccount(config));
  if (route.allowed === false) throw new Error(`Budget governor blocked copy-draft generation: ${route.constraintReason}.`);
  assertAllowedModel(config, route.model);
  return route;
}

async function nextPath(outDir, date, slug) {
  for (let n = 1; ; n += 1) {
    const file = join(outDir, `${date}-${slug}${n === 1 ? '' : `-${n}`}.json`);
    if (!existsSync(file)) return file;
  }
}

export async function runCopyDrafts({ brief: briefInput, hard = false, dryRun = false, outDir = DEFAULT_OUT_DIR, now = new Date(), config: configOverride, budgetState } = {}) {
  const brief = parseBrief(briefInput);
  const config = configOverride || await loadCopyDraftConfig();
  const { minVariants, maxVariants, maxOutputTokens } = config.generation;
  const system = buildSystemPrompt({ min: minVariants, max: maxVariants });
  const user = buildUserPrompt(brief);

  const state = budgetState || (await loadBudgetSnapshot()).state;
  const route = chooseModel(config, { hard, budgetState: state });
  preflightPaidGeneration({ state, route });
  if (dryRun) return { dryRun: true, brief, model: route.model, system, user };

  const body = {
    model: route.model, store: false, max_output_tokens: maxOutputTokens,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    text: { format: { type: 'json_schema', name: 'copy_drafts', schema: variantsSchema({ min: minVariants, max: maxVariants }), strict: true } }
  };
  // One call per brief. openaiRequest charges the daily openaiCallsPerDay counter (durable when
  // SNS_DURABLE_BUDGETS=true) once per logical call and throws BUDGET_EXHAUSTED when it is used up.
  const response = await openaiRequest('/responses', body, { accountId: config.accountId, account: budgetAccount(config), operation: 'copy-drafts', retries: 1 });
  const parsed = parseJsonText(outputText(response));
  const variants = (parsed.variants || []).map((variant, index) => ({ id: index + 1, ...variant }));
  const errors = checkVariants(variants, brief, { minVariants });
  if (errors.length) {
    const error = new Error(`Generated copy failed quality checks:\n- ${errors.join('\n- ')}`);
    error.code = 'COPY_QUALITY_FAILED'; error.violations = errors; error.variants = variants; error.usage = response.usage || null;
    throw error;
  }

  const date = localDateKey(now, 'Asia/Tokyo');
  const slug = briefSlug(brief);
  await mkdir(outDir, { recursive: true });
  const file = await nextPath(outDir, date, slug);
  const result = {
    meta: {
      generated_at: now.toISOString(), model: response.model || route.model, prompt_version: config.promptVersion,
      brief: { character: brief.character, scene: brief.scene, media: brief.media, platforms: brief.platforms }
    },
    variants
  };
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const usage = response.usage || {};
  await appendFile(join(outDir, 'usage.jsonl'), `${JSON.stringify({
    at: now.toISOString(), file: file.slice(outDir.length + 1), model: result.meta.model, requested_model: route.model,
    input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null, total_tokens: usage.total_tokens ?? null,
    openai_calls: 1
  })}\n`, 'utf8');
  return { file, result, usage: response.usage || null, route };
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const briefFile = arg('--brief-file') || process.env.BRIEF_FILE;
    const briefJson = arg('--brief-json') || process.env.BRIEF_JSON;
    if (!briefFile && !briefJson) throw new Error('Provide a brief via --brief-file/BRIEF_FILE or --brief-json/BRIEF_JSON.');
    const brief = briefJson || await readFile(join(ROOT, briefFile), 'utf8');
    const hard = process.argv.includes('--hard') || String(process.env.HARD || '').toLowerCase() === 'true';
    const out = await runCopyDrafts({ brief, hard, dryRun: process.argv.includes('--dry-run') });
    if (out.dryRun) {
      console.log(JSON.stringify({ model: out.model, system: out.system, user: out.user }, null, 2));
    } else {
      console.log(`Saved ${out.file} (${out.result.variants.length} variants, model ${out.result.meta.model}, usage ${JSON.stringify(out.usage)})`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Copy drafts\n- file: \`${out.file.replace(ROOT, '')}\`\n- model: ${out.result.meta.model}\n- OpenAI calls: 1\n- tokens: ${JSON.stringify(out.usage)}\n`);
      }
    }
  } catch (error) {
    console.error(error.message);
    if (error.code === 'COPY_QUALITY_FAILED') console.error(JSON.stringify({ usage: error.usage, variants: error.variants }, null, 2));
    process.exitCode = 1;
  }
}
