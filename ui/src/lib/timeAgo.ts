const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string, locale?: string, now = Date.now()): string {
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (!locale) {
    if (seconds < MINUTE) return "just now";
    if (seconds < HOUR) {
      const minutes = Math.floor(seconds / MINUTE);
      return `${minutes}m ago`;
    }
    if (seconds < DAY) {
      const hours = Math.floor(seconds / HOUR);
      return `${hours}h ago`;
    }
    if (seconds < WEEK) {
      const days = Math.floor(seconds / DAY);
      return `${days}d ago`;
    }
    if (seconds < MONTH) {
      const weeks = Math.floor(seconds / WEEK);
      return `${weeks}w ago`;
    }
    const months = Math.floor(seconds / MONTH);
    return `${months}mo ago`;
  }

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });

  if (seconds < MINUTE) return formatter.format(0, "second");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return formatter.format(-m, "minute");
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return formatter.format(-h, "hour");
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return formatter.format(-d, "day");
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return formatter.format(-w, "week");
  }
  const mo = Math.floor(seconds / MONTH);
  return formatter.format(-mo, "month");
}
