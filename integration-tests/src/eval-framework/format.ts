function safe(n: number, fallback: string): string | null {
  return Number.isFinite(n) ? null : fallback;
}

export const fmt = {
  score(n: number): string {
    return safe(n, "n/a") ?? n.toFixed(3);
  },
  pct(n: number, decimals = 0): string {
    const fb = safe(n, "n/a");
    if (fb !== null) return fb;
    return `${(n * 100).toFixed(decimals)}%`;
  },
  cost(n: number): string {
    const fb = safe(n, "$0.0000");
    if (fb !== null) return fb;
    return `$${n.toFixed(4)}`;
  },
  durationMs(n: number): string {
    const fb = safe(n, "0.0s");
    if (fb !== null) return fb;
    return `${(n / 1000).toFixed(1)}s`;
  },
  threshold(n: number): string {
    return fmt.pct(n);
  },
  tokens(input: number, output: number): string {
    const i = Number.isFinite(input) ? input : 0;
    const o = Number.isFinite(output) ? output : 0;
    return `${i}/${o}`;
  },
  timestamp(iso: string | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    const y = d.getUTCFullYear();
    const mo = pad(d.getUTCMonth() + 1);
    const da = pad(d.getUTCDate());
    const h = pad(d.getUTCHours());
    const mi = pad(d.getUTCMinutes());
    const s = pad(d.getUTCSeconds());
    return `${y}-${mo}-${da} ${h}:${mi}:${s} UTC`;
  },
  range(startIso: string, endIso: string | undefined): string {
    if (!endIso) return fmt.timestamp(startIso);
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return `${fmt.timestamp(startIso)} → ${fmt.timestamp(endIso)}`;
    }
    const sameDate =
      start.getUTCFullYear() === end.getUTCFullYear() &&
      start.getUTCMonth() === end.getUTCMonth() &&
      start.getUTCDate() === end.getUTCDate();
    if (!sameDate) {
      return `${fmt.timestamp(startIso)} → ${fmt.timestamp(endIso)}`;
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = pad(end.getUTCHours());
    const mi = pad(end.getUTCMinutes());
    const s = pad(end.getUTCSeconds());
    return `${fmt.timestamp(startIso)} → ${h}:${mi}:${s} UTC`;
  },
};
