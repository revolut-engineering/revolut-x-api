export interface ErrorResponse {
  error_id: string;
  message: string;
  timestamp: number;
}

export interface PaginationMetadata {
  timestamp: number;
  next_cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  metadata: PaginationMetadata;
}

export interface DataResponse<T> {
  data: T;
}

export interface DataArrayResponse<T> {
  data: T[];
}

export interface PaginationOptions {
  cursor?: string;
  limit?: number;
}

export interface DateRangeOptions {
  startDate?: number;
  endDate?: number;
}
