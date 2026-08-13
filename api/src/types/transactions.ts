export type TransactionType = "buy" | "sell" | "send" | "receive";

export type TransactionStatus =
  | "pending"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";

interface TransactionBase {
  id: string;
  status: TransactionStatus;
  type: TransactionType;
  created_date: number;
  processed_date?: number;
}

interface TransactionSource {
  source_currency: string;
  source_amount: string;
}

interface TransactionDestination {
  destination_currency: string;
  destination_amount: string;
}

export type Transaction = TransactionBase &
  (
    | (TransactionSource & TransactionDestination)
    | (TransactionSource & {
        destination_currency?: never;
        destination_amount?: never;
      })
    | (TransactionDestination & {
        source_currency?: never;
        source_amount?: never;
      })
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
