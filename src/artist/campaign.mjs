const DEFAULT_OFFSETS = [
  { dayOffset: 1, angle: 'performance-clip', lane: 'musicAndCreation' },
  { dayOffset: 3, angle: 'lyric', lane: 'musicAndCreation' },
  { dayOffset: 5, angle: 'production', lane: 'worldview' },
  { dayOffset: 8, angle: 'taste-connection', lane: 'tasteDiscovery' },
  { dayOffset: 12, angle: 'alternate-performance', lane: 'musicAndCreation' }
];

export function campaignOrbit({
  event,
  now = new Date(),
  metrics = null,
  availableAssets = [],
  humanPostedToday = false
} = {}) {
  if (!event) return { active: false, slots: [], why: 'no campaign event' };
  const start = Date.parse(event.at || event.day0 || '');
  if (!Number.isFinite(start)) return { active: false, slots: [], why: 'event missing day0' };
  const elapsedDays = Math.floor((now.getTime() - start) / 86400_000);
  const theme = event.entityName || event.title || 'release';
  const slots = DEFAULT_OFFSETS.map((row) => ({
    ...row,
    due: elapsedDays >= row.dayOffset,
    skipIfHumanCopied: true,
    forbidden: [`copy the day-0 announcement for ${theme} every day`]
  }));
  const chosen = DEFAULT_OFFSETS.find((row) => row.dayOffset === elapsedDays) || null;
  if (humanPostedToday && chosen) {
    return {
      active: true,
      eventType: event.type || 'release',
      theme,
      elapsedDays,
      slots,
      today: null,
      decision: 'defer-to-human-anchor',
      why: `Day ${elapsedDays}: 本人が告知済みなので AI は同じ発表をコピーしない。Orbit は別angleへ再評価。`
    };
  }
  if (!chosen) {
    return { active: true, eventType: event.type || 'release', theme, elapsedDays, slots, today: null, decision: 'no-fixed-slot', why: '固定日程のコピーではなく、反応・素材・手動投稿に応じて空ける。' };
  }
  if (!availableAssets.length && chosen.angle.includes('performance')) {
    return {
      active: true,
      eventType: event.type || 'release',
      theme,
      elapsedDays,
      slots,
      today: { ...chosen, blocked: true },
      decision: 'wait-for-asset',
      why: '該当素材がないのに告知を量産しない。'
    };
  }
  const metricShift = metrics?.profileVisits != null && metrics.profileVisits === 0;
  return {
    active: true,
    eventType: event.type || 'release',
    theme,
    elapsedDays,
    slots,
    today: chosen,
    decision: 'orbit',
    why: metricShift
      ? `Day ${elapsedDays}: ${chosen.angle}。反応が薄い場合は固定スケジュールを守らず入口を変える。`
      : `Day ${elapsedDays}: Human Anchor Event の周囲に ${chosen.angle} を置く。本人告知の毎日コピーはしない。`
  };
}

export const __test = { DEFAULT_OFFSETS };
