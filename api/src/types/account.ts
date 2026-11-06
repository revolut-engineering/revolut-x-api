export interface AccountBalance {
  currency: string;
  available: string;
  reserved: string;
  total: string;
  staked?: string;
}

export interface SubAccount {
  name: string;
  total_balance: { amount: string; currency: string };
  created_date: number;
  updated_date: number;
}

export interface SubAccountsOptions {
  convertTo?: string;
}

export interface SubAccountsResponse {
  data: { sub_accounts: SubAccount[] };
  metadata: { timestamp: number; convert_to: string };
}
