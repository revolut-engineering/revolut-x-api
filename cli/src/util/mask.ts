export function maskSecret(secret: string): string {
  if (secret.length <= 10) return "****";
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
