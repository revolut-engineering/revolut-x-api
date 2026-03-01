
const TELEGRAM_API_BASE = "https://api.telegram.org";
const SEND_TIMEOUT = 10_000;

export interface TelegramResult {
  success: boolean;
  error?: string;
}

export async function sendMessage(
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

    if (response.ok) {
      return { success: true };
    }

    const body = (await response.text()).slice(0, 200);
    return { success: false, error: `HTTP ${response.status}: ${body}` };
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

export function redactToken(botToken: string): string {
  if (botToken.length <= 4) {
    return "****";
  }
  return `****${botToken.slice(-4)}`;
}
