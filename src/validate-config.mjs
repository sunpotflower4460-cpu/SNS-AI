import { loadConfig } from './lib/config.mjs';
import { validateTimeString } from './lib/schedule.mjs';

function merged(config, account, key) { return { ...(config.defaults?.[key] || {}), ...(account?.[key] || {}) }; }
function positive(errors, id, label, value) { if (value != null && (!Number.isFinite(Number(value)) || Number(value) <= 0)) errors.push(`${id}: ${label} must be a positive number`); }

export function validateConfig(config) {
  const errors = []; const modes = new Set(['auto', 'approval', 'manual', 'pause']); const platforms = new Set(['x', 'instagram']);
  const experimentDimensions = new Set(['hook', 'format', 'cta', 'mediaDecision']);
  const imageQualities = new Set(['low', 'medium', 'high', 'auto']);
  const imageSizes = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
  for (const [id, account] of Object.entries(config.accounts || {})) {
    if (!platforms.has(account.platform)) errors.push(`${id}: invalid platform "${account.platform}"`);
    if (!modes.has(account.mode || 'pause')) errors.push(`${id}: invalid mode "${account.mode}"`);
    for (const time of account.schedule?.times || []) if (!validateTimeString(time)) errors.push(`${id}: invalid schedule time "${time}"`);
    for (const time of account.schedule?.adaptiveCandidateTimes || []) if (!validateTimeString(time)) errors.push(`${id}: invalid adaptive candidate time "${time}"`);

    const generation = merged(config, account, 'generation');
    positive(errors, id, 'generation.historyWindow', generation.historyWindow);
    positive(errors, id, 'generation.maxAttempts', generation.maxAttempts);
    positive(errors, id, 'generation.candidateCount', generation.candidateCount);
    positive(errors, id, 'generation.maxOutputTokens', generation.maxOutputTokens);
    if (generation.duplicateThreshold != null && (Number(generation.duplicateThreshold) < 0 || Number(generation.duplicateThreshold) > 1)) errors.push(`${id}: generation.duplicateThreshold must be 0..1`);

    const learning = merged(config, account, 'learning');
    if (learning.exploreRate != null && (Number(learning.exploreRate) < 0 || Number(learning.exploreRate) > 1)) errors.push(`${id}: learning.exploreRate must be 0..1`);
    if (learning.adaptiveScheduleMinConfidence != null && (Number(learning.adaptiveScheduleMinConfidence) < 0 || Number(learning.adaptiveScheduleMinConfidence) > 1)) errors.push(`${id}: learning.adaptiveScheduleMinConfidence must be 0..1`);
    positive(errors, id, 'learning.strategyWindowDays', learning.strategyWindowDays);
    positive(errors, id, 'learning.matureCheckpointMinutes', learning.matureCheckpointMinutes);
    positive(errors, id, 'learning.fullConfidencePosts', learning.fullConfidencePosts);

    const analytics = merged(config, account, 'analytics');
    const checkpoints = analytics.checkpointsMinutes || [];
    if (checkpoints.some((v) => !Number.isFinite(Number(v)) || Number(v) <= 0)) errors.push(`${id}: analytics.checkpointsMinutes must contain positive numbers`);

    const resilience = merged(config, account, 'resilience');
    positive(errors, id, 'resilience.failureThreshold', resilience.failureThreshold);
    positive(errors, id, 'resilience.cooldownMinutes', resilience.cooldownMinutes);

    const budgets = merged(config, account, 'budgets');
    if (budgets.enabled !== false) for (const key of ['openaiCallsPerDay', 'webSearchCallsPerDay', 'mediaCallsPerDay', 'imageGenerationsPerDay']) positive(errors, id, `budgets.${key}`, budgets[key]);

    const experiments = merged(config, account, 'experiments');
    for (const dimension of experiments.dimensions || []) if (!experimentDimensions.has(dimension)) errors.push(`${id}: unsupported experiment dimension "${dimension}"`);
    positive(errors, id, 'experiments.minSamplesPerVariant', experiments.minSamplesPerVariant);
    positive(errors, id, 'experiments.maxDays', experiments.maxDays);
    positive(errors, id, 'experiments.minimumStrategySamples', experiments.minimumStrategySamples);

    const maintenance = merged(config, account, 'maintenance');
    for (const key of ['historyRetentionDays', 'metricsRetentionDays', 'usageRetentionDays', 'auditRetentionDays', 'quarantineRetentionDays', 'generatedMediaRetentionDays']) positive(errors, id, `maintenance.${key}`, maintenance[key]);

    const media = merged(config, account, 'media');
    positive(errors, id, 'media.maxDownloadBytes', media.maxDownloadBytes);
    positive(errors, id, 'media.maxHostedImageBytes', media.maxHostedImageBytes);
    if (media.imageQuality && !imageQualities.has(media.imageQuality)) errors.push(`${id}: media.imageQuality must be low, medium, high, or auto`);
    if (media.imageSize && !imageSizes.has(media.imageSize)) errors.push(`${id}: media.imageSize must be auto, 1024x1024, 1536x1024, or 1024x1536`);
    if (media.internalImageGeneration !== false && media.imageModel != null && typeof media.imageModel !== 'string') errors.push(`${id}: media.imageModel must be a string`);

    if (account.enabled && ['auto', 'approval'].includes(account.mode)) {
      if (!account.schedule?.times?.length) errors.push(`${id}: autonomous mode requires schedule.times`);
      if (account.platform === 'instagram') {
        const strategy = media.strategy || 'none';
        const hasLibrary = (media.urls || []).filter(Boolean).length > 0;
        const hasEndpoint = /^https:\/\//i.test(media.endpoint || '');
        const canGenerateImageInternally = media.internalImageGeneration !== false && (media.type || 'image') === 'image';
        if (strategy === 'none') errors.push(`${id}: Instagram autonomous mode requires media strategy`);
        if (strategy === 'pool' && !hasLibrary) errors.push(`${id}: Instagram media pool is empty`);
        if (['fixed', 'external'].includes(strategy) && !media.url) errors.push(`${id}: Instagram media.${strategy} requires media.url`);
        if (strategy === 'endpoint' && !hasEndpoint) errors.push(`${id}: Instagram media.endpoint requires an HTTPS endpoint`);
        if (strategy === 'auto' && !hasLibrary && !hasEndpoint && !canGenerateImageInternally) errors.push(`${id}: Instagram media.auto requires media.urls, HTTPS media.endpoint, or built-in image generation`);
        if (strategy === 'generate' && !hasEndpoint && !canGenerateImageInternally) errors.push(`${id}: Instagram media.generate requires HTTPS media.endpoint or built-in image generation`);
        if ((media.type || 'image') === 'reel' && !hasLibrary && !hasEndpoint && !media.url) errors.push(`${id}: Reel automation requires external video media; built-in image generation cannot provide a Reel`);
      }
    }
  }
  return errors;
}
if (import.meta.url === `file://${process.argv[1]}`) { const config = await loadConfig(); const errors = validateConfig(config); if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); process.exitCode = 1; } else console.log(`Config OK: ${Object.keys(config.accounts).length} accounts.`); }
