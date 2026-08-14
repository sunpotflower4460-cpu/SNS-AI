import { loadConfig } from './lib/config.mjs';
import { validateConfig } from './validate-config.mjs';

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

export function validateStrictConfig(config) {
  const errors = [...validateConfig(config)];
  for (const [id, account] of Object.entries(config.accounts || {})) {
    if (account.enabled != null && typeof account.enabled !== 'boolean') {
      errors.push(`${id}: enabled must be a boolean`);
    }

    const generation = merged(config, account, 'generation');
    strictPositiveInteger(errors, id, 'generation.maxChars', generation.maxChars);

    const safety = merged(config, account, 'safety');
    strictNonNegativeInteger(errors, id, 'safety.maxLinks', safety.maxLinks);
    strictNonNegativeInteger(errors, id, 'safety.maxHashtags', safety.maxHashtags);
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
