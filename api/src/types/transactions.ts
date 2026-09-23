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
  | "cancelled"
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
  account?: TransactionAccountRef;
}

export type Transaction = TransactionBase &
  (
    | { source: TransactionLeg; destination: TransactionLeg }
    | { source: TransactionLeg; destination?: never }
    | { destination: TransactionLeg; source?: never }
  );

export const TRANSACTION_ACCOUNT_TYPES = [
  "revolut",
  "revolut_x",
  "external_fiat",
  "external_crypto",
] as const;

export type TransactionAccountType = (typeof TRANSACTION_ACCOUNT_TYPES)[number];

export interface TransactionAccountRef {
  type: TransactionAccountType;
}

export interface TransactionAccount extends TransactionAccountRef {
  display_name?: string;
  crypto_address?: string;
}

export interface TransactionDetailLeg extends TransactionLeg {
  fee?: string;
  fee_currency?: string;
  account?: TransactionAccount;
}

interface TransactionDetailFields {
  order_id?: string;
  crypto_transaction_hash?: string;
  network?: string;
  description?: string;
}

export type TransactionDetails = TransactionBase &
  TransactionDetailFields &
  (
    | { source: TransactionDetailLeg; destination: TransactionDetailLeg }
    | { source: TransactionDetailLeg; destination?: never }
    | { destination: TransactionDetailLeg; source?: never }
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
