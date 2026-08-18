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
  // Same vacuous-true guard as buildReadinessReport: zero enabled accounts is not readiness.
  const ready = configErrors.length === 0 && enabledRows.length > 0 && enabledRows.every((row) => row.ready);
  return {
    ...base,
    ready,
    state: configErrors.length || enabledRows.some((row) => !row.ready)
      ? 'blocked'
      : (enabledRows.length === 0 ? 'waiting_for_accounts' : 'ready'),
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
  // Fail on `blocked`, not on `!ready`. health.yml runs this daily with --strict, and `ready` is false
  // while no account is enabled - exiting non-zero for that would have Failure Watch open an issue every
  // single day about a repo that is intentionally dormant, training the operator to ignore the alarm.
  if (strict && report.state === 'blocked') process.exitCode = 1;
}
