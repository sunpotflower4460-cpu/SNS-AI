const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const value = (type) => parts.find((part) => part.type === type)?.value;
  const year = Number(value('year'));
  const month = Number(value('month'));
  const day = Number(value('day'));
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: DAY_NAMES[weekdayIndex],
    dateKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

export function validateTimeString(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function learnedHourScore(time, strategy) {
  const hour = `${time.slice(0, 2)}:00`;
  const stat = strategy?.featureStats?.postingHour?.[hour];
  if (!stat) return 50;
  return Number(stat.averageScore || 50) * (0.5 + 0.5 * Number(stat.confidence ?? 0));
}

export function effectiveScheduleTimes(account, strategy = null) {
  const base = (account.schedule?.times || []).filter(validateTimeString);
  if (!base.length) return [];
  if (account.learning?.adaptiveSchedule === false) return base;
  if (Number(strategy?.confidence || 0) < Number(account.learning?.adaptiveScheduleMinConfidence ?? 0.45)) return base;
  const candidates = (account.schedule?.adaptiveCandidateTimes || []).filter(validateTimeString);
  if (candidates.length <= base.length) return base;
  const count = Math.max(Number(account.learning?.adaptiveScheduleKeepAtLeast ?? 1), base.length);
  return [...candidates]
    .sort((a, b) => learnedHourScore(b, strategy) - learnedHourScore(a, strategy))
    .slice(0, Math.min(count, candidates.length))
    .sort();
}

export function findDueSlots(accountId, account, now = new Date(), strategy = null) {
  const schedule = account.schedule;
  const times = effectiveScheduleTimes(account, strategy);
  if (!schedule || !times.length) return [];

  const timeZone = schedule.timezone || 'Asia/Tokyo';
  const windowMinutes = Number(schedule.windowMinutes ?? 30);
  const local = localParts(now, timeZone);
  const allowedDays = schedule.days?.length ? schedule.days : DAY_NAMES;
  if (!allowedDays.includes(local.weekday)) return [];

  const currentMinutes = local.hour * 60 + local.minute;
  return times
    .filter((time) => {
      const [hour, minute] = time.split(':').map(Number);
      const target = hour * 60 + minute;
      return currentMinutes >= target && currentMinutes < target + windowMinutes;
    })
    .map((time) => ({
      slotId: `${accountId}:${local.dateKey}:${time}`,
      accountId,
      time,
      timeZone,
      localDate: local.dateKey
    }));
}

export function localDateKey(date, timeZone = 'Asia/Tokyo') {
  return localParts(date, timeZone).dateKey;
}
