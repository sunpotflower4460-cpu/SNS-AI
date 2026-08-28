import { decideLinkUsage } from '../research/link-policy.mjs';

const URL_PATTERN = /https?:\/\/\S+/gi;

export function stripUrls(text) {
  return String(text || '')
    .replace(URL_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?、。])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The one place a generated draft's URL can be vetoed before publishing, based on the account's
// linkPolicy budget (src/research/link-policy.mjs). An account with no linkPolicy configured resolves
// to the safe unlimited default, so this is a no-op for every account that predates this feature -
// decideLinkUsage always returns allowed:true and the draft passes through unchanged.
export function applyLinkPolicy({ accountId, account, draft, history, now = new Date() }) {
  const hasLink = URL_PATTERN.test(draft?.text || '');
  URL_PATTERN.lastIndex = 0;
  if (!hasLink) return { draft, decision: { allowed: true, reason: 'no-link-in-text' } };

  const wantsLink = draft.features?.linkRequired === true || (draft.features?.linkRequired == null);
  const decision = decideLinkUsage({ accountId, account, history, wantsLink, purpose: draft.features?.linkPurpose || null, now });
  if (decision.allowed) return { draft, decision };

  const strippedText = stripUrls(draft.text);
  return {
    draft: { ...draft, text: strippedText, features: { ...(draft.features || {}), linkRequired: false } },
    decision
  };
}
