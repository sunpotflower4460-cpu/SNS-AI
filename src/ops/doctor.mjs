import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, loadConfig } from '../lib/config.mjs';
import { validateConfig } from '../validate-config.mjs';
import { VIDEOS_API_DEPRECATION_DATE } from '../media/openai-video.mjs';

const REPORT_JSON = fileURLToPath(new URL('../../data/reports/readiness.json', import.meta.url));
const REPORT_MD = fileURLToPath(new URL('../../data/reports/readiness.md', import.meta.url));

function videosApiDaysLeft(now = Date.now()) {
  return Math.ceil((Date.parse(VIDEOS_API_DEPRECATION_DATE) - now) / 86_400_000);
}
// Once the confirmed shutdown date has passed, every real generation attempt is guaranteed to fail
// closed with PROVIDER_DEPRECATED (see media/openai-video.mjs) - readiness must reflect that as a
// blocker, not just a warning, so `ready`/exit code don't stay green for an account that can no longer
// actually publish a Reel.
function videosApiDeprecationMessage(now = Date.now()) {
  const daysLeft = videosApiDaysLeft(now);
  if (daysLeft <= 0) return `OpenAI's Videos API (sora-2/sora-2-pro) was shut down on ${VIDEOS_API_DEPRECATION_DATE}. Built-in Reel generation for this account will fail closed until it is reconfigured to a different media strategy.`;
  return `OpenAI's Videos API (sora-2/sora-2-pro) is scheduled for shutdown on ${VIDEOS_API_DEPRECATION_DATE} (about ${daysLeft} day(s) from now), with no replacement model listed as of this check. Built-in Reel generation for this account will stop working on that date - plan a migration to media.strategy: endpoint or another video source before then.`;
}

function xUsesMedia(account) {
  return account.platform === 'x' && (account.media?.strategy || 'none') !== 'none';
}

function credentialRequirements(account) {
  if (account.platform === 'x') {
    const required = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret'];
    if (xUsesMedia(account)) required.push('oauth2ClientId', 'oauth2RefreshToken');
    return required;
  }
  if (account.platform === 'instagram') return ['accessToken', 'igUserId'];
  return [];
}

function parseCredentials(raw) {
  if (!raw) return { parsed: null, error: null };
  // Do not surface the native JSON.parse error message: it embeds a literal excerpt of the input,
  // and this input is SOCIAL_CREDENTIALS_JSON - real credential material. This report is written to
  // data/reports/ and committed by the health workflow, so any secret excerpt in it becomes permanent
  // git history outside GitHub's secret-masking (which only redacts exact known secret values).
  try { return { parsed: JSON.parse(raw), error: null }; }
  catch { return { parsed: null, error: 'invalid JSON' }; }
}

function usesBuiltInMedia(account) {
  const media = account.media || {};
  const strategy = media.strategy || 'none';
  if (!['auto', 'generate'].includes(strategy) || /^https:\/\//i.test(media.endpoint || '')) return false;
  const type = media.type || 'image';
  if (type === 'reel') return media.internalVideoGeneration !== false;
  return type === 'image' && media.internalImageGeneration !== false;
}

// 'generate' always invokes built-in video generation for a Reel regardless of whether a media
// library is also configured (src/lib/media.mjs's `generated()` never consults media.urls), and
// 'auto' can reach it too whenever the AI-chosen mediaDecision is 'generate', or 'library' with an
// empty pool - so this must NOT be gated on "no library configured" the way the existing
// library/endpoint/built-in fallback warning below it is.
export function usesBuiltInVideoGeneration(account) {
  return (account.media?.type || 'image') === 'reel' && usesBuiltInMedia(account);
}

function usesOpenAI(account) {
  return ['auto', 'approval'].includes(account.mode)
    || account.research?.webSearch === true
    || account.research?.trendIntelligence === true
    || usesBuiltInMedia(account);
}

function credentialExpiry(entry) {
  if (!entry?.expiresAt) return { blockers: [], warnings: [] };
  const expires = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expires)) return { blockers: [], warnings: ['Credential expiresAt is present but not a valid date.'] };
  const days = (expires - Date.now()) / 86_400_000;
  if (days <= 0) return { blockers: ['Credential is expired according to expiresAt.'], warnings: [] };
  if (days <= 14) return { blockers: [], warnings: [`Credential expires in about ${Math.ceil(days)} day(s). Rotate it soon.`] };
  return { blockers: [], warnings: [] };
}

function budgetWarnings(account) {
  if (account.budgets?.enabled === false) return ['Usage budgets are disabled for this account.'];
  const warnings = [];
  for (const key of ['openaiCallsPerDay', 'webSearchCallsPerDay', 'mediaCallsPerDay', 'imageGenerationsPerDay', 'videoGenerationsPerDay']) {
    const value = Number(account.budgets?.[key]);
    if (!Number.isFinite(value) || value <= 0) warnings.push(`${key} has no effective positive cap.`);
  }
  return warnings;
}

function mediaReadiness(account, { now = Date.now() } = {}) {
  const media = account.media || {};
  const strategy = media.strategy || 'none';
  const mediaType = media.type || 'image';
  const blockers = [];
  const warnings = [];
  if (account.platform === 'x') {
    if (!['image', 'reel'].includes(mediaType)) blockers.push('X media.type must be image or reel when media is configured.');
    if (strategy !== 'none') warnings.push('X v2 image/video upload uses OAuth2 user context. Authorize with tweet.write, users.read, media.write, and offline.access. Refreshed OAuth2 tokens are encrypted into data/x-oauth2-state.json using X_OAUTH2_STATE_KEY.');
    if (media.qa?.enabled !== false && ['auto', 'generate'].includes(strategy)) warnings.push('Generated media is subject to pre-publish moderation and visual QA before hosting/publishing.');
    // pool/fixed/external/endpoint strategies resolve existing media URLs and never call the Videos
    // API (see src/lib/media.mjs) - only 'auto'/'generate' without an HTTPS endpoint can actually
    // reach built-in video generation, matching usesBuiltInMedia()'s own predicate.
    if (usesBuiltInVideoGeneration(account)) (videosApiDaysLeft(now) <= 0 ? blockers : warnings).push(videosApiDeprecationMessage(now));
    return { blockers, warnings };
  }
  if (account.platform !== 'instagram') return { blockers, warnings };
  const hasLibrary = (media.urls || []).filter(Boolean).length > 0;
  const hasEndpoint = /^https:\/\//i.test(media.endpoint || '');
  const hasBuiltIn = mediaType === 'reel'
    ? media.internalVideoGeneration !== false
    : mediaType === 'image' && media.internalImageGeneration !== false;

  if (!['image', 'reel'].includes(mediaType)) blockers.push('Instagram media.type must be image or reel.');
  if (strategy === 'none') blockers.push('Instagram requires a media strategy.');
  if (strategy === 'pool' && !hasLibrary) blockers.push('Instagram media pool is empty.');
  if (['fixed', 'external'].includes(strategy) && !/^https:\/\//i.test(media.url || '')) blockers.push(`media.${strategy} requires a public HTTPS URL.`);
  if (strategy === 'endpoint' && !hasEndpoint) blockers.push('media.endpoint requires an HTTPS endpoint.');
  if (['auto', 'generate'].includes(strategy) && !hasLibrary && !hasEndpoint && !hasBuiltIn) blockers.push(`${strategy} needs library media, media.endpoint, or matching built-in media generation.`);
  if (['auto', 'generate'].includes(strategy) && !hasLibrary && !hasEndpoint && hasBuiltIn) {
    warnings.push(`Instagram will rely on built-in OpenAI ${mediaType === 'reel' ? 'video' : 'image'} generation and public GitHub Release hosting; Live Preflight checks the hosting prerequisite without spending a generation.`);
  }
  // Unlike the fallback warning above, this must NOT be gated on "no library configured": 'generate'
  // always uses built-in video generation regardless of a configured library, and 'auto' can too.
  if (usesBuiltInVideoGeneration(account)) (videosApiDaysLeft(now) <= 0 ? blockers : warnings).push(videosApiDeprecationMessage(now));
  warnings.push('Instagram API with Instagram Login requires a Professional account and an access token authorized for instagram_business_basic and instagram_business_content_publish; analytics also requires the relevant Insights access.');
  if (media.qa?.enabled !== false && ['auto', 'generate'].includes(strategy)) warnings.push('Generated media is subject to pre-publish moderation and visual QA before hosting/publishing.');
  return { blockers, warnings };
}

export async function buildReadinessReport({ accountFilter, now = Date.now() } = {}) {
  const config = await loadConfig();
  const accounts = await loadAccounts();
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  const configErrors = validateConfig(config);
  const openaiPresent = Boolean(process.env.OPENAI_API_KEY);
  const xStateKeyPresent = String(process.env.X_OAUTH2_STATE_KEY || '').length >= 32;
  const rawCredentials = process.env.SOCIAL_CREDENTIALS_JSON || '';
  const credentials = parseCredentials(rawCredentials);
  const rows = [];

  for (const [id, account] of Object.entries(accounts)) {
    if (accountFilter && id !== accountFilter) continue;
    const blockers = [];
    const warnings = [...budgetWarnings(account)];
    const liveRelevant = account.enabled === true && account.mode !== 'pause';

    if (liveRelevant && usesOpenAI(account) && !openaiPresent) blockers.push('OPENAI_API_KEY is missing.');
    if (liveRelevant && xUsesMedia(account) && !xStateKeyPresent) blockers.push('X_OAUTH2_STATE_KEY is missing or shorter than 32 characters.');
    if (liveRelevant) {
      if (!rawCredentials) blockers.push('SOCIAL_CREDENTIALS_JSON is missing.');
      else if (credentials.error) blockers.push(`SOCIAL_CREDENTIALS_JSON is invalid JSON: ${credentials.error}`);
      else {
        const credentialKey = account.credentialKey || id;
        const entry = credentials.parsed?.[credentialKey];
        if (!entry) blockers.push(`Credential entry "${credentialKey}" is missing.`);
        else {
          for (const key of credentialRequirements(account)) if (!entry[key]) blockers.push(`Credential "${credentialKey}.${key}" is missing.`);
          const expiry = credentialExpiry(entry);
          blockers.push(...expiry.blockers);
          warnings.push(...expiry.warnings);
        }
      }
      const media = mediaReadiness(account, { now });
      blockers.push(...media.blockers);
      warnings.push(...media.warnings);
    } else if (!account.enabled || account.mode === 'pause') {
      warnings.push('Account is disabled or paused; live readiness checks are informational only.');
    }

    rows.push({ account: id, displayName: account.displayName || id, platform: account.platform, enabled: Boolean(account.enabled), mode: account.mode || 'pause', ready: blockers.length === 0, blockers, warnings });
  }

  const enabledRows = rows.filter((row) => row.enabled && row.mode !== 'pause');
  // `every` on an empty array is true, so with zero enabled accounts this reported ready:true while
  // nothing at all had been configured - no credentials read, no models checked. The go-live checklist
  // asks the operator to confirm "Doctor ready", and that box ticked itself before any key existed.
  // Readiness now means "a live account is actually ready", never "there is nothing to check".
  const ready = configErrors.length === 0 && enabledRows.length > 0 && enabledRows.every((row) => row.ready);
  // `state` and `ready` answer different questions and must not be collapsed. `ready` is the checklist
  // answer ("is a live account actually good to go?"), which zero enabled accounts can never satisfy.
  // `state` is the alarm signal that drives the strict exit code, and a deliberately dormant repo is not
  // an alarm - only configErrors or an enabled-but-broken account are. Config errors are checked before
  // the account count so a typo can never hide behind "nothing is enabled yet".
  const state = configErrors.length || enabledRows.some((row) => !row.ready)
    ? 'blocked'
    : (enabledRows.length === 0 ? 'waiting_for_accounts' : 'ready');
  return {
    schemaVersion: 7,
    accountFilter: accountFilter || null,
    ready,
    state,
    configErrors,
    environment: {
      openaiApiKeyPresent: openaiPresent,
      // Informational only - GROQ_API_KEY is never required. It only accelerates/cheapens research
      // triage for accounts with research.directFetch:true; its absence falls back to OpenAI (see
      // src/ai/provider.mjs and docs/LOW_COST_RESEARCH.md) and must never block readiness.
      groqApiKeyPresent: Boolean(process.env.GROQ_API_KEY),
      xOAuth2StateKeyPresent: xStateKeyPresent,
      socialCredentialsPresent: Boolean(rawCredentials),
      socialCredentialsJsonValid: rawCredentials ? !credentials.error : null,
      mediaServiceTokenPresent: Boolean(process.env.MEDIA_SERVICE_TOKEN)
    },
    accounts: rows
  };
}

function markdown(report) {
  const lines = ['# SNS-AI Readiness', '', `Overall: **${report.state}**`, '', '| Account | Platform | Mode | Ready | Blockers / warnings |', '|---|---|---|---:|---|'];
  for (const row of report.accounts) {
    const notes = [...row.blockers, ...row.warnings.map((x) => `warning: ${x}`)];
    lines.push(`| ${row.account} | ${row.platform} | ${row.mode} | ${row.ready ? 'yes' : 'no'} | ${notes.join('<br>') || '-'} |`);
  }
  if (report.configErrors.length) lines.push('', '## Config errors', ...report.configErrors.map((value) => `- ${value}`));
  lines.push('', '> Secret values are never written to this report; only presence/shape/optional expiry metadata is checked.', '');
  return lines.join('\n');
}

async function writeIfChanged(path, content) {
  let previous = null;
  try { previous = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous === content) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return true;
}

export async function writeReadinessReport(report) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const md = `${markdown(report)}\n`;
  const [jsonChanged, mdChanged] = await Promise.all([writeIfChanged(REPORT_JSON, json), writeIfChanged(REPORT_MD, md)]);
  return jsonChanged || mdChanged;
}

function parseArgValue(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const strict = process.argv.includes('--strict');
  const accountFilter = parseArgValue(process.argv, '--account');
  const report = await buildReadinessReport({ accountFilter });
  if (write && !accountFilter) await writeReadinessReport(report);
  console.log(JSON.stringify(report, null, 2));
  if (strict && !report.ready) process.exitCode = 1;
}

export const __test = { videosApiDaysLeft, videosApiDeprecationMessage };
