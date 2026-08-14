import { fetchJson } from '../../lib/http.mjs';

const IMPACT_BASE = 'https://api.impact.com';

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Impact ${label} is required.`);
  return text;
}

export function buildImpactTrackingLinkRequest({ accountSid, authToken, programId, deepLink, mediaPartnerPropertyId, subId1, sharedId }) {
  const sid = required(accountSid, 'AccountSID');
  const token = required(authToken, 'AuthToken');
  const program = required(programId, 'ProgramId');
  let destination;
  try { destination = new URL(required(deepLink, 'DeepLink')); }
  catch { throw new Error('Impact DeepLink must be a valid URL.'); }
  if (destination.protocol !== 'https:') throw new Error('Impact DeepLink must use HTTPS.');

  const url = new URL(`${IMPACT_BASE}/Mediapartners/${encodeURIComponent(sid)}/Programs/${encodeURIComponent(program)}/TrackingLinks`);
  url.searchParams.set('Type', 'Regular');
  url.searchParams.set('DeepLink', destination.toString());
  if (mediaPartnerPropertyId) url.searchParams.set('MediaPartnerPropertyId', String(mediaPartnerPropertyId));
  if (subId1) url.searchParams.set('subId1', String(subId1).slice(0, 120));
  if (sharedId) url.searchParams.set('sharedId', String(sharedId).slice(0, 120));

  const authorization = Buffer.from(`${sid}:${token}`, 'utf8').toString('base64');
  return {
    url: url.toString(),
    options: {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Basic ${authorization}` },
      retries: 0
    }
  };
}

export async function createImpactTrackingLink(input) {
  const request = buildImpactTrackingLinkRequest(input);
  const body = await fetchJson(request.url, request.options);
  const trackingUrl = String(body?.TrackingURL || '').trim();
  if (!/^https:\/\//i.test(trackingUrl)) throw new Error('Impact tracking-link response did not contain a valid HTTPS TrackingURL.');
  return { trackingUrl, raw: body };
}

export const __test = { IMPACT_BASE, required };
