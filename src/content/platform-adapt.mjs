const X_RULES = [
  'conversation / hook / concise',
  'Do not paste the Instagram caption.',
  'Prefer one judgment a reader can reply to.'
];

const IG_RULES = [
  'visual context / save value / caption format',
  'Do not paste the X post.',
  'Say what the visual is and why it is worth saving.'
];

export function platformCopySpec(platform) {
  if (platform === 'x') return { platform, form: 'x', rules: X_RULES };
  if (platform === 'instagram') return { platform, form: 'instagram', rules: IG_RULES };
  const error = new Error(`Unsupported platform "${platform}".`);
  error.code = 'PLATFORM_UNSUPPORTED';
  throw error;
}

export function isCopyPaste(sourceText, adaptedText) {
  const a = String(sourceText || '').replace(/\s+/g, ' ').trim();
  const b = String(adaptedText || '').replace(/\s+/g, ' ').trim();
  if (!a || !b) return false;
  return a === b;
}

export function assertAdaptedCopy({ platform, sourceText, adaptedText }) {
  const spec = platformCopySpec(platform);
  if (isCopyPaste(sourceText, adaptedText)) {
    const error = new Error('Cross-platform copy must be adapted, not pasted.');
    error.code = 'PLATFORM_COPY_PASTE';
    throw error;
  }
  return spec;
}

export const __test = { X_RULES, IG_RULES };
