/**
 * Small relative-time helper ("just now", "3 days ago", …). No
 * dependency — a handful of ranges covers everything the UI needs.
 */
export function relativeTime(
  isoOrDate: string | Date,
  now: number = Date.now(),
): string {
  const t = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  const diffSec = Math.max(0, (now - t.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Compact form for tight cells: "now", "3d", "2w", "4mo", "1y", or null. */
export function relativeTimeShort(
  isoOrDate: string | Date | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!isoOrDate) return null;
  const t = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  const days = Math.floor(Math.max(0, now - t.getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
