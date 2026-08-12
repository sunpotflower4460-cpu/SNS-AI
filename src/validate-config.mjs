import { loadConfig } from './lib/config.mjs';
import { validateTimeString } from './lib/schedule.mjs';
export function validateConfig(config) {
  const errors = []; const modes = new Set(['auto', 'approval', 'manual', 'pause']); const platforms = new Set(['x', 'instagram']);
  for (const [id, account] of Object.entries(config.accounts || {})) {
    if (!platforms.has(account.platform)) errors.push(`${id}: invalid platform "${account.platform}"`);
    if (!modes.has(account.mode || 'pause')) errors.push(`${id}: invalid mode "${account.mode}"`);
    for (const time of account.schedule?.times || []) if (!validateTimeString(time)) errors.push(`${id}: invalid schedule time "${time}"`);
    const exploreRate = account.learning?.exploreRate ?? config.defaults?.learning?.exploreRate; if (exploreRate != null && (Number(exploreRate) < 0 || Number(exploreRate) > 1)) errors.push(`${id}: learning.exploreRate must be 0..1`);
    const checkpoints = account.analytics?.checkpointsMinutes || config.defaults?.analytics?.checkpointsMinutes || [];
    if (checkpoints.some((v) => !Number.isFinite(Number(v)) || Number(v) <= 0)) errors.push(`${id}: analytics.checkpointsMinutes must contain positive numbers`);
    if (account.enabled && ['auto', 'approval'].includes(account.mode)) {
      if (!account.schedule?.times?.length) errors.push(`${id}: autonomous mode requires schedule.times`);
      if (account.platform === 'instagram') {
        const media = { ...(config.defaults?.media || {}), ...(account.media || {}) }; const strategy = media.strategy || 'none';
        if (strategy === 'none') errors.push(`${id}: Instagram autonomous mode requires media strategy`);
        if (strategy === 'pool' && !(media.urls || []).filter(Boolean).length) errors.push(`${id}: Instagram media pool is empty`);
        if (['fixed', 'external'].includes(strategy) && !media.url) errors.push(`${id}: Instagram media.${strategy} requires media.url`);
        if (strategy === 'endpoint' && !/^https:\/\//i.test(media.endpoint || '')) errors.push(`${id}: Instagram media.endpoint requires an HTTPS endpoint`);
        if (strategy === 'auto' && !(media.urls || []).filter(Boolean).length && !/^https:\/\//i.test(media.endpoint || '')) errors.push(`${id}: Instagram media.auto requires media.urls or HTTPS media.endpoint`);
      }
    }
  }
  return errors;
}
if (import.meta.url === `file://${process.argv[1]}`) { const config = await loadConfig(); const errors = validateConfig(config); if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); process.exitCode = 1; } else console.log(`Config OK: ${Object.keys(config.accounts).length} accounts.`); }
