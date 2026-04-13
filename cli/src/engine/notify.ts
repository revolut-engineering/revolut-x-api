import type { Decimal } from "decimal.js";
import type { EvalResult } from "../shared/indicators/evaluators.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const SEND_TIMEOUT = 10_000;

export interface TelegramResult {
  success: boolean;
  error?: string;
  retryAfter?: number;
}

async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<TelegramResult> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT),
    });
    if (response.ok) return { success: true };
    const body = (await response.text()).slice(0, 200);
    let retryAfter: number | undefined;
    if (response.status === 429) {
      try {
        const parsed = JSON.parse(body);
        retryAfter =
          parsed?.parameters?.retry_after ??
          (Number(response.headers.get("retry-after")) || undefined);
      } catch {
        retryAfter = Number(response.headers.get("retry-after")) || undefined;
      }
    }
    return {
      success: false,
      error: `HTTP ${response.status}: ${body}`,
      retryAfter,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { success: false, error: "Request timed out" };
    }
    if (err instanceof TypeError && (err as Error).message?.includes("abort")) {
      return { success: false, error: "Request timed out" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg.slice(0, 200) };
  }
}

export async function sendWithRetries(
  botToken: string,
  chatId: string,
  text: string,
  maxRetries = 3,
): Promise<TelegramResult> {
  let lastResult: TelegramResult = {
    success: false,
    error: "No attempts made",
  };
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await sendMessage(botToken, chatId, text);
    if (result.success) return result;
    lastResult = result;
    if (attempt < maxRetries - 1) {
      const delay = result.retryAfter
        ? result.retryAfter * 1000
        : 2 ** attempt * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return lastResult;
}

const TYPE_LABELS: Record<string, string> = {
  price: "\u{1f4c8} Price Alert",
  rsi: "\u{1f4ca} RSI Alert",
  ema_cross: "\u{1f4ca} EMA Cross Alert",
  macd: "\u{1f4ca} MACD Alert",
  bollinger: "\u{1f4ca} Bollinger Alert",
  volume_spike: "\u{1f4ca} Volume Alert",
  spread: "\u{1f4cf} Spread Alert",
  obi: "\u{1f4ca} Order Book Alert",
  price_change_pct: "\u{1f4ca} Price Change Alert",
  atr_breakout: "\u{26a1} ATR Breakout Alert",
};

export function formatNotification(
  alertType: string,
  pair: string,
  price: Decimal,
  result: EvalResult,
): string {
  const label = TYPE_LABELS[alertType] ?? `\u{1f4ca} ${alertType} Alert`;
  const lines = [`${label}: ${pair}`];
  if (result.detail) lines.push(result.detail);
  if (alertType !== "price") lines.push(`\u{1f4b0} Price: ${price}`);
  return lines.join("\n");
}
