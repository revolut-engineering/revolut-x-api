export function parseTimestamp(value: string): number {
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
