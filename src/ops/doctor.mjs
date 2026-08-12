import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, loadConfig } from '../lib/config.mjs';
import { validateConfig } from '../validate-config.mjs';

const REPORT_JSON = fileURLToPath(new URL('../../data/reports/readiness.json', import.meta.url));
const REPORT_MD = fileURLToPath(new URL('../../data/reports/readiness.md', import.meta.url));

function credentialRequirements(platform) {
  if (platform === 'x') return ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret'];
  if (platform === 'instagram') return ['accessToken', 'igUserId'];
  return [];
}

function parseCredentials(raw) {
  if (!raw) return { parsed: null, error: null };
  try { return { parsed: JSON.parse(raw), error: null }; }
  catch (error) { return { parsed: null, error: error.message }; }
}

function usesOpenAI(account) {
  return ['auto', 'approval'].includes(account.mode)
    || account.research?.webSearch === true
    || account.research?.trendIntelligence === true;
}

function mediaBlockers(account) {
  if (account.platform !== 'instagram') return [];
  const media = account.media || {};
  const strategy = media.strategy || 'none';
  if (strategy === 'none') return ['Instagram requires a media strategy.'];
  if (strategy === 'pool' && !(media.urls || []).filter(Boolean).length) return ['Instagram media pool is empty.'];
  if (['fixed', 'external'].includes(strategy) && !/^https:\/\//i.test(media.url || '')) return [`media.${strategy} requires a public HTTPS URL.`];
  if (strategy === 'endpoint' && !/^https:\/\//i.test(media.endpoint || '')) return ['media.endpoint requires an HTTPS endpoint.'];
  if (strategy === 'auto') {
    const hasLibrary = (media.urls || []).filter(Boolean).length > 0;
    const hasEndpoint = /^https:\/\//i.test(media.endpoint || '');
    if (!hasLibrary && !hasEndpoint) return ['media.strategy=auto needs media.urls and/or media.endpoint before live Instagram publishing.'];
  }
  return [];
}

export async function buildReadinessReport() {
  const config = await loadConfig();
  const accounts = await loadAccounts();
  const configErrors = validateConfig(config);
  const openaiPresent = Boolean(process.env.OPENAI_API_KEY);
  const rawCredentials = process.env.SOCIAL_CREDENTIALS_JSON || '';
  const credentials = parseCredentials(rawCredentials);
  const rows = [];

  for (const [id, account] of Object.entries(accounts)) {
    const blockers = [];
    const warnings = [];
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
          for (const key of credentialRequirements(account.platform)) {
            if (!entry[key]) blockers.push(`Credential "${credentialKey}.${key}" is missing.`);
          }
        }
      }
      blockers.push(...mediaBlockers(account));
    } else if (!account.enabled || account.mode === 'pause') {
      warnings.push('Account is disabled or paused; live readiness checks are informational only.');
    }

    rows.push({
      account: id,
      displayName: account.displayName || id,
      platform: account.platform,
      enabled: Boolean(account.enabled),
      mode: account.mode || 'pause',
      ready: blockers.length === 0,
      blockers,
      warnings
    });
  }

  const enabledRows = rows.filter((row) => row.enabled && row.mode !== 'pause');
  return {
    schemaVersion: 1,
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
  const lines = [
    '# SNS-AI Readiness',
    '',
    `Overall: **${report.state}**`,
    '',
    '| Account | Platform | Mode | Ready | Blockers |',
    '|---|---|---|---:|---|'
  ];
  for (const row of report.accounts) {
    lines.push(`| ${row.account} | ${row.platform} | ${row.mode} | ${row.ready ? 'yes' : 'no'} | ${row.blockers.join('<br>') || '-'} |`);
  }
  if (report.configErrors.length) {
    lines.push('', '## Config errors', ...report.configErrors.map((value) => `- ${value}`));
  }
  lines.push('', '> Secret values are never written to this report; only presence/shape is checked.', '');
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
  const [jsonChanged, mdChanged] = await Promise.all([
    writeIfChanged(REPORT_JSON, json),
    writeIfChanged(REPORT_MD, md)
  ]);
  return jsonChanged || mdChanged;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const strict = process.argv.includes('--strict');
  const report = await buildReadinessReport();
  if (write) await writeReadinessReport(report);
  console.log(JSON.stringify(report, null, 2));
  if (strict && !report.ready) process.exitCode = 1;
}
