export type TransactionType =
  | "buy"
  | "sell"
  | "receive"
  | "send"
  | "stake"
  | "un_stake"
  | "reward";

export type TransactionStatus =
  | "pending"
  | "completed"
  | "canceled"
  | "failed"
  | "reverted";

interface TransactionBase {
  id: string;
  status: TransactionStatus;
  type: TransactionType;
  created_date: number;
  processed_date?: number;
}

interface TransactionLeg {
  amount: string;
  currency: string;
}

export type Transaction = TransactionBase &
  (
    | { source: TransactionLeg; destination: TransactionLeg }
    | { source: TransactionLeg; destination?: never }
    | { destination: TransactionLeg; source?: never }
  );

export interface TransactionsOptions {
  startDate?: number;
  endDate?: number;
  types?: TransactionType[];
  statuses?: TransactionStatus[];
  currencies?: string[];
  cursor?: string;
  limit?: number;
}
