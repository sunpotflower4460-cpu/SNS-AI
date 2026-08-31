const ANCHOR_TYPES = [
  'manual-x-post',
  'manual-instagram-post',
  'release',
  'live-announce',
  'live-performed',
  'mv-release',
  'production-note',
  'artist-comment',
  'mysns-seed',
  'confirmed-taste',
  'new-asset'
];

function sourceOf(entry) {
  if (entry?.anchorType && ANCHOR_TYPES.includes(entry.anchorType)) return entry.anchorType;
  if (entry?.kind && ANCHOR_TYPES.includes(entry.kind)) return entry.kind;
  if (entry?.platform === 'instagram') return 'manual-instagram-post';
  return 'manual-x-post';
}

export function isHumanAnchorEntry(entry) {
  if (!entry) return false;
  if (entry.humanAuthored === true || entry.sourceKind === 'human') return true;
  if (entry.anchorType && ANCHOR_TYPES.includes(entry.anchorType)) return true;
  return entry.source && !['sns-ai', 'auto', 'approval'].includes(entry.source);
}

export function collectHumanAnchors({
  history = [],
  events = [],
  accountId = null,
  lookbackHours = 72,
  now = new Date(),
  ingestConnected = false
} = {}) {
  const cutoff = now.getTime() - lookbackHours * 3600_000;
  const fromHistory = (history || []).filter((entry) => {
    if (accountId && entry.account && entry.account !== accountId) return false;
    if (!isHumanAnchorEntry(entry)) return false;
    const at = Date.parse(entry.at || entry.occurredAt || '');
    return Number.isFinite(at) && at >= cutoff;
  }).map((entry) => ({
    type: sourceOf(entry),
    text: entry.text || entry.summary || '',
    entityName: entry.entityName || entry.songId || null,
    at: entry.at || entry.occurredAt,
    source: ingestConnected && entry.ingestSource === 'bridge' ? 'bridge' : 'sns-ai-local-history',
    overwriteForbidden: true
  }));

  const fromEvents = (events || []).filter((event) => {
    const at = Date.parse(event.at || event.occurredAt || '');
    return Number.isFinite(at) && at >= cutoff;
  }).map((event) => ({
    type: event.anchorType || event.type || 'artist-comment',
    text: event.text || event.summary || '',
    entityName: event.entityName || event.songId || null,
    at: event.at || event.occurredAt,
    source: event.source || 'event',
    overwriteForbidden: true
  }));

  const anchors = [...fromHistory, ...fromEvents].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
  return {
    anchors,
    ingestConnected: Boolean(ingestConnected),
    localHistoryOnly: !ingestConnected,
    note: ingestConnected
      ? 'Anchors include Bridge/My-SNS snapshots.'
      : 'Anchors are from SNS-AI local history only. Unconnected ingest must not be described as having read My-SNS manual posts.'
  };
}

export function manualActivityCount(anchorSet, { hours = 24, now = new Date() } = {}) {
  const cutoff = now.getTime() - hours * 3600_000;
  return (anchorSet?.anchors || []).filter((row) => Date.parse(row.at || 0) >= cutoff).length;
}

export const __test = { ANCHOR_TYPES, sourceOf };
