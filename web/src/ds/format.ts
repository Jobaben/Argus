export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function sparklinePoints(
  values: number[],
  width = 100,
  height = 26,
): string {
  const n = values.length;
  if (n === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v, i) => {
      const x = n === 1 ? 0 : (i / (n - 1)) * width;
      // y inverted: max -> 0 (top), min -> height (bottom); flat -> midline
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
