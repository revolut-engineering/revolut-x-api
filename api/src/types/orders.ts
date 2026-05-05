export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "conditional" | "tpsl";
export type OrderStatus =
  | "pending_new"
  | "new"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "replaced";
export type ActiveOrderState = "pending_new" | "new" | "partially_filled";
export type HistoricalOrderState =
  | "filled"
  | "cancelled"
  | "rejected"
  | "replaced"
  | "partially_filled";
export type ActiveOrderType = "limit" | "conditional" | "tpsl";
export type HistoricalOrderType = "market" | "limit";
export type TimeInForce = "gtc" | "ioc" | "fok";
export type ExecutionInstruction = "allow_taker" | "post_only";
export type TriggerDirection = "ge" | "le";

export interface OrderTrigger {
  trigger_price: string;
  type: "market" | "limit";
  trigger_direction: TriggerDirection;
  limit_price?: string;
  time_in_force: "gtc" | "ioc";
  execution_instructions: ExecutionInstruction[];
}

export interface Order {
  id: string;
  previous_order_id?: string;
  client_order_id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  filled_quantity: string;
  filled_amount?: string;
  leaves_quantity: string;
  amount?: string;
  price: string;
  average_fill_price?: string;
  status: OrderStatus;
  reject_reason?: string;
  time_in_force: TimeInForce;
  execution_instructions: ExecutionInstruction[];
  conditional?: OrderTrigger;
  take_profit?: OrderTrigger;
  stop_loss?: OrderTrigger;
  created_date: number;
  updated_date: number;
}

export interface OrderDetails {
  id: string;
  previous_order_id?: string;
  client_order_id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  filled_quantity: string;
  filled_amount?: string;
  leaves_quantity: string;
  amount?: string;
  price: string;
  average_fill_price?: string;
  total_fee?: string;
  fee_currency?: string;
  status: OrderStatus;
  reject_reason?: string;
  time_in_force: TimeInForce;
  execution_instructions: ExecutionInstruction[];
  conditional?: OrderTrigger;
  take_profit?: OrderTrigger;
  stop_loss?: OrderTrigger;
  created_date: number;
  updated_date: number;
}

export interface OrderPlacementResult {
  venue_order_id: string;
  client_order_id: string;
  state: OrderStatus;
}

export interface LimitOrderConfig {
  price: string;
  baseSize?: string;
  quoteSize?: string;
  executionInstructions?: ExecutionInstruction[];
}

export interface MarketOrderConfig {
  baseSize?: string;
  quoteSize?: string;
}

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  limit?: LimitOrderConfig;
  market?: MarketOrderConfig;
  clientOrderId?: string;
}

export interface ActiveOrdersOptions {
  symbols?: string[];
  orderStates?: ActiveOrderState[];
  orderTypes?: ActiveOrderType[];
  side?: OrderSide;
  cursor?: string;
  limit?: number;
}

export interface HistoricalOrdersOptions {
  symbols?: string[];
  orderStates?: HistoricalOrderState[];
  orderTypes?: HistoricalOrderType[];
  startDate?: number;
  endDate?: number;
  cursor?: string;
  limit?: number;
}
