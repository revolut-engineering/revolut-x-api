export function parseTimestamp(value: string): number {
  const trimmed = value.trim().toLowerCase();

  if (trimmed === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  if (trimmed === "yesterday") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.getTime();
  }

  const relMatch = trimmed.match(
    /^(\d+)\s*(d|days?|w|weeks?|h|hours?|m|minutes?)$/,
  );
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = Date.now();
    if (unit.startsWith("d")) return now - n * 86400000;
    if (unit.startsWith("w")) return now - n * 7 * 86400000;
    if (unit.startsWith("h")) return now - n * 3600000;
    if (unit.startsWith("m")) return now - n * 60000;
  }

  const num = Number(value);
  if (!isNaN(num)) return num;

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    console.error(`Error: Invalid date: ${value}`);
    process.exit(1);
  }
  return date.getTime();
}

export function parsePositiveInt(value: string, name: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    console.error(`Error: ${name} must be a positive integer, got: ${value}`);
    process.exit(1);
  }
  return num;
}
