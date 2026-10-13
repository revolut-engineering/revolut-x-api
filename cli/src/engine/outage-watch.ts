import { AuthenticationError, ForbiddenError } from "@revolut/revolut-x-api";

export const OUTAGE_ALERT_MS = 5 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const CAUSE_DEPTH = 5;

export type ExchangeFault = "refused" | "unreachable";

export interface OutageAlert {
  readonly fault: ExchangeFault;
  readonly minutes: number;
  readonly retry: boolean;
}

export function refusalOf(
  err: unknown,
): AuthenticationError | ForbiddenError | null {
  let current: unknown = err;
  for (
    let depth = 0;
    current instanceof Error && depth < CAUSE_DEPTH;
    depth++
  ) {
    if (
      current instanceof AuthenticationError ||
      current instanceof ForbiddenError
    ) {
      return current;
    }
    current = current.cause;
  }
  return null;
}

export function exchangeFault(err: unknown): ExchangeFault {
  return refusalOf(err) ? "refused" : "unreachable";
}

export class OutageWatch {
  private _since: number | null = null;
  private _alerted: OutageAlert | null = null;
  private _alertedBefore: OutageAlert | null = null;
  private _lost: { fault: ExchangeFault; resendAt: number } | null = null;
  private _recovery: OutageAlert | null = null;
  private _lostRecovery: { alert: OutageAlert; resendAt: number } | null = null;

  failed(fault: ExchangeFault, now = Date.now()): OutageAlert | null {
    this._since ??= now;
    this._recovery = null;
    this._lostRecovery = null;
    if (!this._due(fault, now)) return null;
    const retry = this._lost?.fault === fault;
    this._lost = null;
    this._alertedBefore = this._alerted;
    this._alerted = { fault, minutes: this._minutes(now), retry };
    return this._alerted;
  }

  undelivered(alert: OutageAlert, now = Date.now()): void {
    if (alert === this._recovery) {
      this._recovery = null;
      this._lostRecovery = { alert, resendAt: now + RESEND_AFTER_MS };
      return;
    }
    if (alert === this._alertedBefore) {
      this._alertedBefore = null;
      return;
    }
    if (alert !== this._alerted) return;
    this._alerted = this._alertedBefore;
    this._alertedBefore = null;
    this._lost = { fault: alert.fault, resendAt: now + RESEND_AFTER_MS };
  }

  recovered(now = Date.now()): OutageAlert | null {
    const recovery = this._alerted
      ? {
          fault: this._alerted.fault,
          minutes: this._minutes(now),
          retry: false,
        }
      : this._dueRecovery(now);
    this._since = null;
    this._alerted = null;
    this._alertedBefore = null;
    this._lost = null;
    if (recovery) this._recovery = recovery;
    return recovery;
  }

  private _dueRecovery(now: number): OutageAlert | null {
    if (!this._lostRecovery || now < this._lostRecovery.resendAt) return null;
    const recovery = { ...this._lostRecovery.alert, retry: true };
    this._lostRecovery = null;
    return recovery;
  }

  private _due(fault: ExchangeFault, now: number): boolean {
    if (this._lost?.fault === fault && now < this._lost.resendAt) return false;
    if (fault === "refused") return this._alerted?.fault !== "refused";
    return (
      this._alerted === null &&
      this._since !== null &&
      now - this._since >= OUTAGE_ALERT_MS
    );
  }

  private _minutes(now: number): number {
    if (this._since === null) return 0;
    return Math.max(0, Math.round((now - this._since) / 60_000));
  }
}
