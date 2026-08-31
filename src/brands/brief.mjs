const PLATFORM_TONES = {
  x: {
    form: 'conversation / hook / concise',
    rules: [
      'Open with a hook a reader can reply to or quote.',
      'Stay concise. One judgment, not a brochure.',
      'Do not paste an Instagram caption.'
    ]
  },
  instagram: {
    form: 'visual context / save value / caption format',
    rules: [
      'Lead with what the visual is and why it is worth saving.',
      'Keep a caption structure, not a tweet thread.',
      'Do not paste an X post.'
    ]
  }
};

export function buildCoreContentBrief({
  brandId,
  sharedResearchId,
  topic,
  entity = null,
  facts = {},
  judgment = {},
  relationship = 'independent',
  evidenceLevel = null,
  sources = []
} = {}) {
  return {
    schemaVersion: 1,
    brandId: brandId || null,
    sharedResearchId: sharedResearchId || null,
    topic: String(topic || '').trim(),
    entity: entity ? {
      entityName: entity.entityName || entity.name || null,
      vendor: entity.vendor || null,
      canonicalUrl: entity.canonicalUrl || null
    } : null,
    facts: {
      price: facts.price ?? null,
      saleEnd: facts.saleEnd ?? null,
      releaseDate: facts.releaseDate ?? null,
      version: facts.version ?? null,
      license: facts.license ?? null,
      compatibility: facts.compatibility ?? null,
      systemRequirements: facts.systemRequirements ?? null,
      confirmation: facts.confirmation || 'unconfirmed'
    },
    judgment: {
      whoItIsFor: judgment.whoItIsFor || null,
      whatIsNew: judgment.whatIsNew || null,
      worthBuying: judgment.worthBuying || null,
      whoCanSkip: judgment.whoCanSkip || null,
      alternatives: judgment.alternatives || []
    },
    relationship,
    evidenceLevel,
    sources: (sources || []).slice(0, 30)
  };
}

export function adaptBriefForPlatform(brief, platform) {
  const tone = PLATFORM_TONES[platform];
  if (!tone) {
    const error = new Error(`Unsupported platform "${platform}" for brief adaptation.`);
    error.code = 'BRIEF_PLATFORM_UNSUPPORTED';
    throw error;
  }
  return {
    ...brief,
    platform,
    copyBrief: {
      form: tone.form,
      rules: tone.rules,
      reuse: 'same-research-not-copy-paste'
    }
  };
}

export function xAndInstagramFromBrief(brief) {
  return {
    core: brief,
    x: adaptBriefForPlatform(brief, 'x'),
    instagram: adaptBriefForPlatform(brief, 'instagram')
  };
}

export const __test = { PLATFORM_TONES };
