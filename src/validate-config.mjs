import { loadConfig } from './lib/config.mjs';
import { validateTimeString } from './lib/schedule.mjs';

function merged(config, account, key) { return { ...(config.defaults?.[key] || {}), ...(account?.[key] || {}) }; }
function positive(errors, id, label, value) { if (value != null && (!Number.isFinite(Number(value)) || Number(value) <= 0)) errors.push(`${id}: ${label} must be a positive number`); }
function nonNegative(errors, id, label, value) { if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) errors.push(`${id}: ${label} must be a non-negative number`); }
function range(errors, id, label, value, min, max) { if (value != null && (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max)) errors.push(`${id}: ${label} must be ${min}..${max}`); }
function validTimeZone(value) {
  if (!value || typeof value !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)); return true; }
  catch { return false; }
}

export function validateConfig(config) {
  const errors = []; const modes = new Set(['auto', 'approval', 'manual', 'pause']); const platforms = new Set(['x', 'instagram']);
  const dayNames = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  const experimentDimensions = new Set(['hook', 'format', 'cta', 'mediaDecision']);
  const imageQualities = new Set(['low', 'medium', 'high', 'auto']);
  const imageSizes = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
  const videoSizes = new Set(['720x1280', '1280x720', '1024x1792', '1792x1024']);
  const videoSeconds = new Set([4, 8, 12]);
  const qaDetails = new Set(['low', 'high', 'auto']);
  for (const [id, account] of Object.entries(config.accounts || {})) {
    const mode = account.mode ?? config.defaults?.mode ?? 'pause';
    if (!platforms.has(account.platform)) errors.push(`${id}: invalid platform "${account.platform}"`);
    if (!modes.has(mode)) errors.push(`${id}: invalid mode "${mode}"`);
    for (const time of account.schedule?.times || []) if (!validateTimeString(time)) errors.push(`${id}: invalid schedule time "${time}"`);
    for (const time of account.schedule?.adaptiveCandidateTimes || []) if (!validateTimeString(time)) errors.push(`${id}: invalid adaptive candidate time "${time}"`);
    for (const day of account.schedule?.days || []) if (!dayNames.has(day)) errors.push(`${id}: invalid schedule day "${day}"`);
    if (account.schedule) {
      const timeZone = account.schedule.timezone || config.defaults?.timezone || 'Asia/Tokyo';
      if (!validTimeZone(timeZone)) errors.push(`${id}: invalid schedule timezone "${timeZone}"`);
      range(errors, id, 'schedule.windowMinutes', account.schedule.windowMinutes, 1, 1440);
    }

    const generation = merged(config, account, 'generation');
    positive(errors, id, 'generation.historyWindow', generation.historyWindow);
    positive(errors, id, 'generation.maxAttempts', generation.maxAttempts);
    positive(errors, id, 'generation.candidateCount', generation.candidateCount);
    positive(errors, id, 'generation.maxOutputTokens', generation.maxOutputTokens);
    range(errors, id, 'generation.duplicateThreshold', generation.duplicateThreshold, 0, 1);

    const learning = merged(config, account, 'learning');
    range(errors, id, 'learning.exploreRate', learning.exploreRate, 0, 1);
    range(errors, id, 'learning.adaptiveScheduleMinConfidence', learning.adaptiveScheduleMinConfidence, 0, 1);
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
    if (budgets.enabled !== false) for (const key of ['openaiCallsPerDay', 'webSearchCallsPerDay', 'mediaCallsPerDay', 'imageGenerationsPerDay', 'videoGenerationsPerDay']) nonNegative(errors, id, `budgets.${key}`, budgets[key]);

    const safety = merged(config, account, 'safety');
    nonNegative(errors, id, 'safety.maxPostsPerDay', safety.maxPostsPerDay);
    nonNegative(errors, id, 'safety.minMinutesBetweenPosts', safety.minMinutesBetweenPosts);
    const brake = safety.anomalyBrake || {};
    if (brake.enabled !== false) {
      positive(errors, id, 'safety.anomalyBrake.matureCheckpointMinutes', brake.matureCheckpointMinutes);
      positive(errors, id, 'safety.anomalyBrake.minBaselinePosts', brake.minBaselinePosts);
      range(errors, id, 'safety.anomalyBrake.minConfidence', brake.minConfidence, 0, 1);
      positive(errors, id, 'safety.anomalyBrake.minExposure', brake.minExposure);
      range(errors, id, 'safety.anomalyBrake.severeScoreThreshold', brake.severeScoreThreshold, 0, 100);
      range(errors, id, 'safety.anomalyBrake.lowScoreThreshold', brake.lowScoreThreshold, 0, 100);
      positive(errors, id, 'safety.anomalyBrake.consecutiveLowPosts', brake.consecutiveLowPosts);
      positive(errors, id, 'safety.anomalyBrake.conversationSpikeMultiplier', brake.conversationSpikeMultiplier);
      range(errors, id, 'safety.anomalyBrake.minimumConversationRate', brake.minimumConversationRate, 0, 1);
      positive(errors, id, 'safety.anomalyBrake.cooldownHours', brake.cooldownHours);
      if (Number(brake.severeScoreThreshold) > Number(brake.lowScoreThreshold)) errors.push(`${id}: anomalyBrake.severeScoreThreshold should be <= lowScoreThreshold`);
    }

    const experiments = merged(config, account, 'experiments');
    for (const dimension of experiments.dimensions || []) if (!experimentDimensions.has(dimension)) errors.push(`${id}: unsupported experiment dimension "${dimension}"`);
    positive(errors, id, 'experiments.minSamplesPerVariant', experiments.minSamplesPerVariant);
    positive(errors, id, 'experiments.maxDays', experiments.maxDays);
    positive(errors, id, 'experiments.minimumStrategySamples', experiments.minimumStrategySamples);

    const maintenance = merged(config, account, 'maintenance');
    for (const key of ['historyRetentionDays', 'metricsRetentionDays', 'usageRetentionDays', 'auditRetentionDays', 'quarantineRetentionDays', 'generatedMediaRetentionDays']) positive(errors, id, `maintenance.${key}`, maintenance[key]);

    const media = merged(config, account, 'media');
    const mediaType = media.type || 'image';
    const strategy = media.strategy || 'none';
    const hasLibrary = (media.urls || []).filter(Boolean).length > 0;
    const hasEndpoint = /^https:\/\//i.test(media.endpoint || '');
    const canGenerateInternally = mediaType === 'image'
      ? media.internalImageGeneration !== false
      : mediaType === 'reel' && media.internalVideoGeneration !== false;
    if (!['image', 'reel'].includes(mediaType)) errors.push(`${id}: media.type must be image or reel`);
    positive(errors, id, 'media.maxDownloadBytes', media.maxDownloadBytes);
    positive(errors, id, 'media.maxHostedImageBytes', media.maxHostedImageBytes);
    positive(errors, id, 'media.maxHostedVideoBytes', media.maxHostedVideoBytes);
    if (media.imageQuality && !imageQualities.has(media.imageQuality)) errors.push(`${id}: media.imageQuality must be low, medium, high, or auto`);
    if (media.imageSize && !imageSizes.has(media.imageSize)) errors.push(`${id}: unsupported media.imageSize "${media.imageSize}"`);
    if (media.videoSize && !videoSizes.has(media.videoSize)) errors.push(`${id}: unsupported media.videoSize "${media.videoSize}"`);
    if (media.videoSeconds != null && !videoSeconds.has(Number(media.videoSeconds))) errors.push(`${id}: media.videoSeconds must be 4, 8, or 12`);
    positive(errors, id, 'media.videoTimeoutMinutes', media.videoTimeoutMinutes);
    positive(errors, id, 'media.videoPollSeconds', media.videoPollSeconds);
    if (media.internalImageGeneration !== false && media.imageModel != null && typeof media.imageModel !== 'string') errors.push(`${id}: media.imageModel must be a string`);
    if (media.internalVideoGeneration !== false && media.videoModel != null && typeof media.videoModel !== 'string') errors.push(`${id}: media.videoModel must be a string`);
    const qa = media.qa || {};
    if (qa.enabled !== false) {
      range(errors, id, 'media.qa.minScore', qa.minScore, 0, 100);
      if (qa.maxRegenerations != null && (!Number.isInteger(Number(qa.maxRegenerations)) || Number(qa.maxRegenerations) < 0 || Number(qa.maxRegenerations) > 5)) errors.push(`${id}: media.qa.maxRegenerations must be an integer 0..5`);
      positive(errors, id, 'media.qa.maxInputBytes', qa.maxInputBytes);
      if (qa.detail && !qaDetails.has(qa.detail)) errors.push(`${id}: media.qa.detail must be low, high, or auto`);
    }

    if (account.enabled && ['auto', 'approval'].includes(mode)) {
      if (!account.schedule?.times?.length) errors.push(`${id}: autonomous mode requires schedule.times`);
      if (account.platform === 'instagram') {
        if (strategy === 'none') errors.push(`${id}: Instagram autonomous mode requires media strategy`);
        if (strategy === 'pool' && !hasLibrary) errors.push(`${id}: Instagram media pool is empty`);
        if (['fixed', 'external'].includes(strategy) && !media.url) errors.push(`${id}: Instagram media.${strategy} requires media.url`);
        if (strategy === 'endpoint' && !hasEndpoint) errors.push(`${id}: Instagram media.endpoint requires an HTTPS endpoint`);
        if (['auto', 'generate'].includes(strategy) && !hasLibrary && !hasEndpoint && !canGenerateInternally) errors.push(`${id}: Instagram ${strategy} requires library media, HTTPS media.endpoint, or matching built-in generation`);
      }
      if (account.platform === 'x' && strategy !== 'none') {
        if (strategy === 'pool' && !hasLibrary) errors.push(`${id}: X media pool is empty`);
        if (['fixed', 'external'].includes(strategy) && !media.url) errors.push(`${id}: X media.${strategy} requires media.url`);
        if (strategy === 'endpoint' && !hasEndpoint) errors.push(`${id}: X media.endpoint requires an HTTPS endpoint`);
        if (strategy === 'generate' && !hasEndpoint && !canGenerateInternally) errors.push(`${id}: X generate requires HTTPS media.endpoint or matching built-in generation`);
        if (strategy === 'auto' && !hasLibrary && !hasEndpoint && !canGenerateInternally) errors.push(`${id}: X auto with media configured requires library media, HTTPS media.endpoint, or matching built-in generation`);
      }
    }
  }
  return errors;
}
if (import.meta.url === `file://${process.argv[1]}`) { const config = await loadConfig(); const errors = validateConfig(config); if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); process.exitCode = 1; } else console.log(`Config OK: ${Object.keys(config.accounts).length} accounts.`); }
