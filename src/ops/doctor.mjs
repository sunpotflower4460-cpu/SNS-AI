import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, loadConfig } from '../lib/config.mjs';
import { validateConfig } from '../validate-config.mjs';

const REPORT_JSON = fileURLToPath(new URL('../../data/reports/readiness.json', import.meta.url));
const REPORT_MD = fileURLToPath(new URL('../../data/reports/readiness.md', import.meta.url));

function xUsesMedia(account) {
  return account.platform === 'x' && (account.media?.strategy || 'none') !== 'none';
}

function credentialRequirements(account) {
  if (account.platform === 'x') {
    const required = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret'];
    if (xUsesMedia(account)) required.push('oauth2AccessToken', 'oauth2RefreshToken');
    return required;
  }
  if (account.platform === 'instagram') return ['accessToken', 'igUserId'];
  return [];
}

function parseCredentials(raw) {
  if (!raw) return { parsed: null, error: null };
  try { return { parsed: JSON.parse(raw), error: null }; }
  catch (error) { return { parsed: null, error: error.message }; }
}

function usesBuiltInMedia(account) {
  const media = account.media || {};
  const strategy = media.strategy || 'none';
  if (!['auto', 'generate'].includes(strategy) || /^https:\/\//i.test(media.endpoint || '')) return false;
  const type = media.type || 'image';
  if (type === 'reel') return media.internalVideoGeneration !== false;
  return type === 'image' && media.internalImageGeneration !== false;
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

function mediaReadiness(account) {
  const media = account.media || {};
  const strategy = media.strategy || 'none';
  const mediaType = media.type || 'image';
  const blockers = [];
  const warnings = [];
  if (account.platform === 'x') {
    if (!['image', 'reel'].includes(mediaType)) blockers.push('X media.type must be image or reel when media is configured.');
    if (strategy !== 'none') warnings.push('X v2 image/video upload uses OAuth2 user context. Authorize with tweet.write, users.read, media.write, and offline.access; oauth2RefreshToken is required as evidence of offline authorization.');
    if (media.qa?.enabled !== false && ['auto', 'generate'].includes(strategy)) warnings.push('Generated media is subject to pre-publish moderation and visual QA before hosting/publishing.');
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
  warnings.push('Instagram API with Instagram Login requires a Professional account and an access token authorized for instagram_business_basic and instagram_business_content_publish; analytics also requires the relevant Insights access.');
  if (media.qa?.enabled !== false && ['auto', 'generate'].includes(strategy)) warnings.push('Generated media is subject to pre-publish moderation and visual QA before hosting/publishing.');
  return { blockers, warnings };
}

export async function buildReadinessReport({ accountFilter } = {}) {
  const config = await loadConfig();
  const accounts = await loadAccounts();
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  const configErrors = validateConfig(config);
  const openaiPresent = Boolean(process.env.OPENAI_API_KEY);
  const rawCredentials = process.env.SOCIAL_CREDENTIALS_JSON || '';
  const credentials = parseCredentials(rawCredentials);
  const rows = [];

  for (const [id, account] of Object.entries(accounts)) {
    if (accountFilter && id !== accountFilter) continue;
    const blockers = [];
    const warnings = [...budgetWarnings(account)];
    const liveRelevant = account.enabled === true && account.mode !== 'pause';

    if (liveRelevant && usesOpenAI(account) && !openaiPresent) blockers.push('OPENAI_API_KEY is missing.');
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
      const media = mediaReadiness(account);
      blockers.push(...media.blockers);
      warnings.push(...media.warnings);
    } else if (!account.enabled || account.mode === 'pause') {
      warnings.push('Account is disabled or paused; live readiness checks are informational only.');
    }

    rows.push({ account: id, displayName: account.displayName || id, platform: account.platform, enabled: Boolean(account.enabled), mode: account.mode || 'pause', ready: blockers.length === 0, blockers, warnings });
  }

  const enabledRows = rows.filter((row) => row.enabled && row.mode !== 'pause');
  return {
    schemaVersion: 6,
    accountFilter: accountFilter || null,
    ready: configErrors.length === 0 && enabledRows.every((row) => row.ready),
    state: enabledRows.length === 0 ? 'waiting_for_accounts' : (configErrors.length || enabledRows.some((row) => !row.ready) ? 'blocked' : 'ready'),
    configErrors,
    environment: {
      openaiApiKeyPresent: openaiPresent,
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
