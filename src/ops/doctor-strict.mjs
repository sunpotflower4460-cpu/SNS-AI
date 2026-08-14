import { loadConfig } from '../lib/config.mjs';
import { validateStrictConfig } from '../validate-strict-config.mjs';
import { buildReadinessReport, writeReadinessReport } from './doctor.mjs';

function parseArgValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function buildStrictReadinessReport({ accountFilter } = {}) {
  const [config, base] = await Promise.all([
    loadConfig(),
    buildReadinessReport({ accountFilter })
  ]);
  const configErrors = validateStrictConfig(config);
  const enabledRows = base.accounts.filter((row) => row.enabled && row.mode !== 'pause');
  const ready = configErrors.length === 0 && enabledRows.every((row) => row.ready);
  return {
    ...base,
    ready,
    state: enabledRows.length === 0
      ? 'waiting_for_accounts'
      : (configErrors.length || enabledRows.some((row) => !row.ready) ? 'blocked' : 'ready'),
    configErrors
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const strict = process.argv.includes('--strict');
  const accountFilter = parseArgValue(process.argv, '--account');
  const report = await buildStrictReadinessReport({ accountFilter });
  if (write && !accountFilter) await writeReadinessReport(report);
  console.log(JSON.stringify(report, null, 2));
  if (strict && !report.ready) process.exitCode = 1;
}
