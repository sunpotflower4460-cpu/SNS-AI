import { loadConfig } from './lib/config.mjs';
import { assertPublicHttpsUrl } from './lib/http.mjs';
import { validateConfig } from './validate-config.mjs';

const MEDIA_STRATEGIES = new Set(['none', 'fixed', 'external', 'pool', 'endpoint', 'generate', 'auto']);

function merged(config, account, key) {
  return { ...(config.defaults?.[key] || {}), ...(account?.[key] || {}) };
}

function strictPositiveInteger(errors, id, label, value) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    errors.push(`${id}: ${label} must be a positive integer`);
  }
}

function strictNonNegativeInteger(errors, id, label, value) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push(`${id}: ${label} must be a non-negative integer`);
  }
}

function strictBoolean(errors, id, label, value) {
  if (value == null) return;
  if (typeof value !== 'boolean') errors.push(`${id}: ${label} must be a boolean`);
}

function strictRange(errors, id, label, value, min, max) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${id}: ${label} must be a number in ${min}..${max}`);
  }
}

function strictObject(errors, id, label, value) {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${id}: ${label} must be an object`);
    return false;
  }
  return true;
}

function validHttps(value) {
  if (typeof value !== 'string') return false;
  try {
    assertPublicHttpsUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function validateStrictConfig(config) {
  const errors = [...validateConfig(config)];
  for (const [id, account] of Object.entries(config.accounts || {})) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) continue;
    strictBoolean(errors, id, 'enabled', account.enabled);

    const generation = merged(config, account, 'generation');
    strictPositiveInteger(errors, id, 'generation.maxChars', generation.maxChars);
    if (strictObject(errors, id, 'generation.naturalization', generation.naturalization) && generation.naturalization) {
      const naturalization = generation.naturalization;
      strictBoolean(errors, id, 'generation.naturalization.enabled', naturalization.enabled);
      strictBoolean(errors, id, 'generation.naturalization.deepReview', naturalization.deepReview);
      strictRange(errors, id, 'generation.naturalization.minNaturalness', naturalization.minNaturalness, 0, 100);
      strictRange(errors, id, 'generation.naturalization.maxAiPatternRisk', naturalization.maxAiPatternRisk, 0, 100);
      strictRange(errors, id, 'generation.naturalization.minVoiceFit', naturalization.minVoiceFit, 0, 100);
      if (naturalization.maxIssues != null && (typeof naturalization.maxIssues !== 'number' || !Number.isInteger(naturalization.maxIssues) || naturalization.maxIssues < 1 || naturalization.maxIssues > 8)) {
        errors.push(`${id}: generation.naturalization.maxIssues must be an integer 1..8`);
      }
      if (naturalization.model != null && typeof naturalization.model !== 'string') {
        errors.push(`${id}: generation.naturalization.model must be a string`);
      }
    }

    const safety = merged(config, account, 'safety');
    strictNonNegativeInteger(errors, id, 'safety.maxLinks', safety.maxLinks);
    strictNonNegativeInteger(errors, id, 'safety.maxHashtags', safety.maxHashtags);
    strictBoolean(errors, id, 'safety.moderation', safety.moderation);
    strictObject(errors, id, 'safety.anomalyBrake', safety.anomalyBrake);
    strictBoolean(errors, id, 'safety.anomalyBrake.enabled', safety.anomalyBrake?.enabled);

    const analytics = merged(config, account, 'analytics');
    strictBoolean(errors, id, 'analytics.enabled', analytics.enabled);
    strictPositiveInteger(errors, id, 'analytics.maxAgeDays', analytics.maxAgeDays);
    if (analytics.enabled !== false) {
      if (!Array.isArray(analytics.checkpointsMinutes) || analytics.checkpointsMinutes.length === 0) {
        errors.push(`${id}: analytics.checkpointsMinutes must contain at least one checkpoint when analytics is enabled`);
      } else {
        for (const value of analytics.checkpointsMinutes) strictPositiveInteger(errors, id, 'analytics.checkpointsMinutes[]', value);
      }
    }

    const learning = merged(config, account, 'learning');
    strictBoolean(errors, id, 'learning.enabled', learning.enabled);
    strictBoolean(errors, id, 'learning.adaptiveSchedule', learning.adaptiveSchedule);

    const research = merged(config, account, 'research');
    strictBoolean(errors, id, 'research.webSearch', research.webSearch);
    strictBoolean(errors, id, 'research.trendIntelligence', research.trendIntelligence);

    const resilience = merged(config, account, 'resilience');
    strictBoolean(errors, id, 'resilience.enabled', resilience.enabled);

    const budgets = merged(config, account, 'budgets');
    strictBoolean(errors, id, 'budgets.enabled', budgets.enabled);
    if (budgets.enabled !== false) {
      for (const key of ['openaiCallsPerDay', 'webSearchCallsPerDay', 'mediaCallsPerDay', 'imageGenerationsPerDay', 'videoGenerationsPerDay']) {
        strictNonNegativeInteger(errors, id, `budgets.${key}`, budgets[key]);
      }
    }

    const experiments = merged(config, account, 'experiments');
    strictBoolean(errors, id, 'experiments.enabled', experiments.enabled);

    const media = merged(config, account, 'media');
    const strategy = media.strategy || 'none';
    if (!MEDIA_STRATEGIES.has(strategy)) errors.push(`${id}: unsupported media.strategy "${strategy}"`);
    strictBoolean(errors, id, 'media.internalImageGeneration', media.internalImageGeneration);
    strictBoolean(errors, id, 'media.internalVideoGeneration', media.internalVideoGeneration);
    if (strictObject(errors, id, 'media.qa', media.qa) && media.qa) {
      strictBoolean(errors, id, 'media.qa.enabled', media.qa.enabled);
      strictBoolean(errors, id, 'media.qa.selectedSemanticReview', media.qa.selectedSemanticReview);
    }

    if (media.endpoint != null && media.endpoint !== '' && !validHttps(media.endpoint)) {
      errors.push(`${id}: media.endpoint must be a valid HTTPS URL to a public network destination`);
    }
    if (['fixed', 'external'].includes(strategy) && media.url != null && media.url !== '' && !validHttps(media.url)) {
      errors.push(`${id}: media.url must be a valid HTTPS URL to a public network destination for ${strategy}`);
    }

    const configuredUrls = media.urls ?? media.libraryUrls ?? [];
    if (!Array.isArray(configuredUrls)) {
      errors.push(`${id}: media.urls must be an array`);
    } else {
      for (const [index, url] of configuredUrls.entries()) {
        if (url && !validHttps(url)) errors.push(`${id}: media.urls[${index}] must be a valid HTTPS URL to a public network destination`);
      }
    }
  }
  return [...new Set(errors)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await loadConfig();
  const errors = validateStrictConfig(config);
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Config OK: ${Object.keys(config.accounts).length} accounts.`);
  }
}
