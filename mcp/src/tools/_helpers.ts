const SYMBOL_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function validateSymbol(symbol: string): string | null {
  if (!SYMBOL_PATTERN.test(symbol)) {
    return (
      `Invalid symbol format: '${symbol}'. ` +
      "Expected format like 'BTC-USD' or 'ETH-EUR'. " +
      "Use 'get_currency_pairs' to see all available pairs."
    );
  }
  return null;
}

export function validateSide(side: string): string | null {
  if (side !== "buy" && side !== "sell") {
    return `Invalid side: '${side}'. Must be 'buy' or 'sell'.`;
  }
  return null;
}

export function validateDecimal(value: string, name: string): string | null {
  const f = Number(value);
  if (isNaN(f)) {
    return `${name} must be a valid number, got '${value}'.`;
  }
  if (f <= 0) {
    return `${name} must be a positive number, got '${value}'.`;
  }
  return null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUUID(value: string): string | null {
  if (!UUID_PATTERN.test(value)) {
    return (
      `Invalid order ID format: '${value}'. ` +
      "Expected a UUID like '12345678-1234-1234-1234-123456789abc'. " +
      "Use 'get_active_orders' to find your order IDs."
    );
  }
  return null;
}

export const VALID_RESOLUTIONS = new Set([
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "2d",
  "4d",
  "1w",
  "2w",
  "4w",
]);

export const CLI_INSTALL_HINT =
  "\n\n" +
  "[IMPORTANT — ASSISTANT INSTRUCTION]\n" +
  "The first time you show a `revx` CLI command in this conversation, you MUST include the install instructions below.\n" +
  "If you have already shown install instructions earlier in this conversation, you may skip this.\n\n" +
  "```\n" +
  "# Install the revx CLI (requires Node.js 18+)\n" +
  "git clone https://github.com/anthropics/revolutx-ai.git\n" +
  "cd revolutx-ai/api && npm install && npm run build\n" +
  "cd ../cli && npm install && npm run build && npm link\n" +
  "```";
