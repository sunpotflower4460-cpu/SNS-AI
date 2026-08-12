import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openaiRequest } from '../lib/openai.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { recordUsage } from '../ops/budget.mjs';

const PLATFORMS = {
  x: {
    domains: ['help.x.com', 'docs.x.com'],
    focus: 'automation rules, API posting rules, spam/platform manipulation rules, developer terms relevant to automated posting and analytics'
  },
  instagram: {
    domains: ['developers.facebook.com', 'developers.meta.com', 'developers.instagram.com', 'help.instagram.com'],
    focus: 'Instagram API publishing, content publishing permissions, automation/developer rules, branded content/disclosure rules relevant to automated publishing and insights'
  }
};

function outputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) if (item.type === 'message') for (const content of item.content || []) if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
  return '';
}

function citations(response) {
  const found = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const citation = value.type === 'url_citation' ? value : value.url_citation;
    const url = citation?.url || (value.type === 'url_citation' ? value.url : null);
    const title = citation?.title || (value.type === 'url_citation' ? value.title : null);
    if (typeof url === 'string' && /^https:\/\//i.test(url)) found.set(url, { url, title: typeof title === 'string' ? title : null });
    for (const child of Object.values(value)) visit(child);
  };
  visit(response?.output || []);
  return [...found.values()];
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Policy Watch response was not JSON.');
  }
}

function allowedSource(url, domains) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

function stableDigest(value) {
  const canonical = JSON.stringify({
    rules: (value.rules || []).map((x) => ({ id: x.id, rule: x.rule, impact: x.impact })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    actionItems: [...(value.actionItems || [])].sort()
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function pathFor(platform) { return fileURLToPath(new URL(`../../data/policies/${platform}.json`, import.meta.url)); }

async function researchPlatform(platform, previous) {
  const config = PLATFORMS[platform];
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['summary', 'rules', 'actionItems', 'requiresHumanReview'],
    properties: {
      summary: { type: 'string' },
      rules: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id', 'rule', 'impact'], properties: {
        id: { type: 'string' }, rule: { type: 'string' }, impact: { type: 'string' }
      } } },
      actionItems: { type: 'array', maxItems: 10, items: { type: 'string' } },
      requiresHumanReview: { type: 'boolean' }
    }
  };
  const body = {
    model: process.env.OPENAI_MODEL || 'gpt-5',
    store: false,
    max_output_tokens: 2500,
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    input: [
      { role: 'system', content: [{ type: 'input_text', text: `Check current official ${platform} platform/developer policy information. Use ONLY official sources on these domains: ${config.domains.join(', ')}. Focus on ${config.focus}. Do not infer a policy change from third-party commentary. If evidence is unclear, set requiresHumanReview=true and say what is unclear.` }] },
      { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ previous: previous ? { checkedAt: previous.checkedAt, summary: previous.summary, rules: previous.rules, actionItems: previous.actionItems } : null }) }] }
    ],
    text: { format: { type: 'json_schema', name: 'platform_policy_watch', schema, strict: true } }
  };
  const response = await openaiRequest('/responses', body, { retries: 2 });
  await recordUsage('_system', { timezone: 'UTC' }, 'openai', { operation: `policy-watch:${platform}` });
  const parsed = parseJson(outputText(response));
  const sources = citations(response).filter((source) => allowedSource(source.url, config.domains)).slice(0, 30);
  if (!sources.length) {
    parsed.requiresHumanReview = true;
    parsed.actionItems = [...new Set([...(parsed.actionItems || []), 'No official-domain URL citation was captured; verify policy manually before changing automation.'])];
  }
  const digest = stableDigest(parsed);
  return {
    platform,
    checkedAt: new Date().toISOString(),
    summary: String(parsed.summary || ''),
    rules: parsed.rules || [],
    actionItems: parsed.actionItems || [],
    requiresHumanReview: Boolean(parsed.requiresHumanReview),
    sources,
    digest,
    changedFromPrevious: Boolean(previous?.digest && previous.digest !== digest)
  };
}

export async function runPolicyWatch() {
  const results = [];
  for (const platform of Object.keys(PLATFORMS)) {
    const previous = await readJson(pathFor(platform), null);
    try {
      const report = await researchPlatform(platform, previous);
      await writeJsonAtomic(pathFor(platform), report);
      results.push({ platform, status: 'updated', changed: report.changedFromPrevious, requiresHumanReview: report.requiresHumanReview, report });
    } catch (error) {
      results.push({ platform, status: 'failed', error: error.message });
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runPolicyWatch();
  console.log(JSON.stringify(report, null, 2));
  if (report.some((row) => row.status === 'failed')) process.exitCode = 1;
}
