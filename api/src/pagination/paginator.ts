import { RateLimitError } from "../http/errors.js";
import { RATE_LIMIT_MAX_RETRIES } from "./constants.js";

const INITIAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SHRINK_THRESHOLD = 3;

const MIN_START_DATE_MS = new Date("2024-05-07T00:00:00Z").getTime();

export type FetchPage<T> = (
  startDate: number,
  endDate: number,
  cursor: string | undefined,
  limit: number,
) => Promise<{ data: T[]; metadata?: { next_cursor?: string } }>;

export interface PaginateOptions<T> {
  fetchPage: FetchPage<T>;
  startDate: number;
  endDate: number;
  apiLimit: number;
  userLimit?: number;
}

export async function paginateWithDynamicWindows<T>(
  opts: PaginateOptions<T>,
): Promise<T[]> {
  opts.startDate = Math.max(opts.startDate, MIN_START_DATE_MS);

  if (opts.startDate > opts.endDate) {
    return [];
  }

  const allItems: T[] = [];
  let windowMs = INITIAL_WINDOW_MS;
  let currentEnd = opts.endDate;

  while (currentEnd >= opts.startDate) {
    const currentStart = Math.max(currentEnd - windowMs, opts.startDate);

    let cursor: string | undefined = undefined;
    let rateLimitRetries = 0;
    let pagesInWindow = 0;
    let hitRateLimit = false;

    while (true) {
      try {
        const result = await opts.fetchPage(
          currentStart,
          currentEnd,
          cursor,
          opts.apiLimit,
        );

        rateLimitRetries = 0;

        if (result.data && result.data.length > 0) {
          pagesInWindow++;

          if (opts.userLimit !== undefined) {
            const remaining = opts.userLimit - allItems.length;
            allItems.push(...result.data.slice(0, remaining));
          } else {
            allItems.push(...result.data);
          }
        }

        if (opts.userLimit !== undefined && allItems.length >= opts.userLimit) {
          break;
        }

        cursor = result.metadata?.next_cursor;
        if (!cursor) break;
      } catch (err) {
        if (
          err instanceof RateLimitError &&
          rateLimitRetries < RATE_LIMIT_MAX_RETRIES
        ) {
          rateLimitRetries++;
          hitRateLimit = true;

          const delay = err.retryAfter ?? 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }

    if (opts.userLimit !== undefined && allItems.length >= opts.userLimit) {
      break;
    }

    if (hitRateLimit || pagesInWindow >= SHRINK_THRESHOLD) {
      windowMs = Math.max(MIN_WINDOW_MS, Math.floor(windowMs / 2));
    } else if (pagesInWindow === 0) {
      windowMs = Math.min(MAX_WINDOW_MS, windowMs * 2);
    }

    currentEnd = currentStart - 1;
  }

  return allItems;
}
