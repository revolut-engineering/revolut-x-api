export interface SlotFailure {
  reason: string;
  order: string;
}

interface SlotHealth {
  countedRejections: Set<string>;
  strikes: number;
  retries: Set<string>;
  failure: SlotFailure | null;
  alerted: boolean;
}

export class PlacementHealth {
  private readonly _slots = new Map<string, SlotHealth>();

  rejected(slot: string, clientOrderId: string): number | null {
    const health = this._slot(slot);
    if (health.countedRejections.has(clientOrderId)) return null;
    health.countedRejections.add(clientOrderId);
    health.strikes++;
    return health.strikes;
  }

  sent(slot: string, orderId: string): void {
    const health = this._slots.get(slot);
    if (!health) return;
    this._resolve(health);
    if (health.strikes > 0) health.retries.add(orderId);
  }

  adopted(slot: string): void {
    const health = this._slots.get(slot);
    if (health) this._resolve(health);
  }

  confirmed(slot: string, orderId: string): void {
    const health = this._slots.get(slot);
    if (!health?.retries.has(orderId)) return;
    health.strikes = 0;
    health.retries.clear();
  }

  failed(slot: string, reason: string, order: string): void {
    this._slot(slot).failure = { reason, order };
  }

  failureReason(slot: string): string | null {
    return this._slots.get(slot)?.failure?.reason ?? null;
  }

  takeAlerts(): SlotFailure[] {
    const alerts: SlotFailure[] = [];
    for (const health of this._slots.values()) {
      if (!health.failure || health.alerted) continue;
      health.alerted = true;
      alerts.push(health.failure);
    }
    return alerts;
  }

  reset(): void {
    this._slots.clear();
  }

  private _slot(slot: string): SlotHealth {
    let health = this._slots.get(slot);
    if (!health) {
      health = {
        countedRejections: new Set(),
        strikes: 0,
        retries: new Set(),
        failure: null,
        alerted: false,
      };
      this._slots.set(slot, health);
    }
    return health;
  }

  private _resolve(health: SlotHealth): void {
    health.failure = null;
    health.alerted = false;
  }
}
