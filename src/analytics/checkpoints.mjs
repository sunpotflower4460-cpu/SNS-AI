export const DEFAULT_CHECKPOINTS = [60, 360, 1440, 4320, 10080];

export function postAgeMinutes(publishedAt, now = new Date()) {
  return Math.max(0, Math.floor((now.getTime() - new Date(publishedAt).getTime()) / 60000));
}

export function nextDueCheckpoint({ publishedAt, snapshots = [], checkpoints = DEFAULT_CHECKPOINTS, now = new Date() }) {
  const age = postAgeMinutes(publishedAt, now);
  const done = new Set((snapshots || []).map((row) => Number(row.checkpointMinutes)));
  for (const checkpoint of [...checkpoints].map(Number).sort((a, b) => a - b)) {
    if (age >= checkpoint && !done.has(checkpoint)) return { checkpointMinutes: checkpoint, actualAgeMinutes: age };
  }
  return null;
}
