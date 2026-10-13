import { ConfigurationError } from "../http/errors.js";

const EXAMPLE = "such as https://revx.revolut.com";

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function shown(value: string): string {
  const url = parseUrl(value.trim());
  if (!url || !url.host) {
    return value
      .trim()
      .replace(/^([a-z][a-z0-9+.-]*:(?:\/\/)?)?[\s\S]*@/i, "$1***@")
      .replace(/([?#])[\s\S]*$/, "$1***");
  }
  const credentials = url.username || url.password ? "***@" : "";
  const path = url.pathname === "/" ? "" : url.pathname;
  const query = url.search ? "?***" : "";
  const fragment = url.hash ? "#***" : "";
  return `${url.protocol}//${credentials}${url.host}${path}${query}${fragment}`;
}

function isThisMachine(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export function normalizeBaseUrl(value: string, source: string): string {
  const refuse = (rule: string): never => {
    throw new ConfigurationError(`${source} ${rule}. Got "${shown(value)}".`);
  };
  const url = parseUrl(value.trim());
  if (!url) return refuse(`must be a web address ${EXAMPLE}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return refuse(`must be a web address ${EXAMPLE}`);
  }
  if (url.protocol === "http:" && !isThisMachine(url.hostname)) {
    return refuse(
      "must start with https://. Plain http:// is allowed only for this machine (localhost, 127.x.x.x or [::1])",
    );
  }
  if (url.username || url.password) {
    return refuse("must not contain a user name or password");
  }
  if (url.port === "0") {
    return refuse("must not use port 0");
  }
  if (url.search || url.hash) {
    return refuse(`must not contain "?" or "#"`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/api(\/1\.0)?$/i.test(path)) {
    return refuse(
      "must not end with /api or /api/1.0. The client adds /api/1.0 itself",
    );
  }
  return `${url.origin}${path}`;
}
