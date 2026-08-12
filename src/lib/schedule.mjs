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

export function findDueSlots(accountId, account, now = new Date()) {
  const schedule = account.schedule;
  if (!schedule?.times?.length) return [];

  const timeZone = schedule.timezone || 'Asia/Tokyo';
  const windowMinutes = Number(schedule.windowMinutes ?? 30);
  const local = localParts(now, timeZone);
  const allowedDays = schedule.days?.length ? schedule.days : DAY_NAMES;
  if (!allowedDays.includes(local.weekday)) return [];

  const currentMinutes = local.hour * 60 + local.minute;
  return schedule.times
    .filter(validateTimeString)
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
