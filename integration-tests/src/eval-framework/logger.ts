export type LogLevel = "silent" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface Logger {
  level: LogLevel;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

function resolveLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.EVAL_LOG_LEVEL ?? "").toLowerCase();
  if (raw === "silent" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "info";
}

function shouldEmit(current: LogLevel, target: LogLevel): boolean {
  return LEVEL_ORDER[current] >= LEVEL_ORDER[target];
}

function format(
  prefix: string,
  message: string,
  fields?: Record<string, unknown>,
): string {
  const head = prefix ? `[eval]${prefix} ${message}` : `[eval] ${message}`;
  if (!fields || Object.keys(fields).length === 0) return head;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return `${head} ${parts.join(" ")}`;
}

function buildLogger(prefix: string): Logger {
  return {
    get level() {
      return resolveLevel(process.env);
    },
    warn(message, fields) {
      if (shouldEmit(this.level, "warn")) {
        console.warn(format(prefix, message, fields));
      }
    },
    info(message, fields) {
      if (shouldEmit(this.level, "info")) {
        console.log(format(prefix, message, fields));
      }
    },
    debug(message, fields) {
      if (shouldEmit(this.level, "debug")) {
        console.log(format(prefix, message, fields));
      }
    },
    child(childPrefix) {
      return buildLogger(`${prefix}[${childPrefix}]`);
    },
  };
}

export const logger = buildLogger("");
