const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function calendarDay(year, month, day, delta = 0) {
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return {
    year: y,
    month: m,
    day: d,
    weekday: DAY_NAMES[date.getUTCDay()],
    dateKey: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  };
}

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
  const calendar = calendarDay(year, month, day);

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: calendar.weekday,
    dateKey: calendar.dateKey
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
  return Number(stat.averageScore ?? 50) * (0.5 + 0.5 * Number(stat.confidence ?? 0));
}

export function effectiveScheduleTimes(account, strategy = null) {
  const base = [...new Set((account.schedule?.times || []).filter(validateTimeString))];
  if (!base.length) return [];
  if (account.learning?.adaptiveSchedule === false) return base;
  if (Number(strategy?.confidence || 0) < Number(account.learning?.adaptiveScheduleMinConfidence ?? 0.45)) return base;
  const candidates = [...new Set((account.schedule?.adaptiveCandidateTimes || []).filter(validateTimeString))];
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
  const configuredWindow = Number(schedule.windowMinutes ?? 30);
  const windowMinutes = Number.isFinite(configuredWindow)
    ? Math.min(1440, Math.max(1, configuredWindow))
    : 30;
  const local = localParts(now, timeZone);
  const currentDay = calendarDay(local.year, local.month, local.day);
  const previousDay = calendarDay(local.year, local.month, local.day, -1);
  const allowedDays = schedule.days?.length ? schedule.days : DAY_NAMES;
  const currentMinutes = local.hour * 60 + local.minute;

  const due = [];
  for (const time of times) {
    const [hour, minute] = time.split(':').map(Number);
    const target = hour * 60 + minute;
    const end = target + windowMinutes;

    if (allowedDays.includes(currentDay.weekday) && currentMinutes >= target && currentMinutes < end) {
      due.push({
        slotId: `${accountId}:${currentDay.dateKey}:${time}`,
        accountId,
        time,
        timeZone,
        localDate: currentDay.dateKey
      });
      continue;
    }

    const spillMinutes = end - 1440;
    if (spillMinutes > 0 && allowedDays.includes(previousDay.weekday) && currentMinutes < spillMinutes) {
      due.push({
        slotId: `${accountId}:${previousDay.dateKey}:${time}`,
        accountId,
        time,
        timeZone,
        localDate: previousDay.dateKey
      });
    }
  }
  return due;
}

export function localDateKey(date, timeZone = 'Asia/Tokyo') {
  return localParts(date, timeZone).dateKey;
}
