export const minutesOf = (hours: number, minutes = 0): number =>
  hours * 60 + minutes;

export const fmtHm = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};

export const fmtClock = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

export const fmtRange = (start: number, end: number): string =>
  `${fmtClock(start)}–${fmtClock(end)}`;
