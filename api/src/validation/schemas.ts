import { z } from "zod";

export const priceSchema = z.string().refine(
  (val) => {
    const num = Number(val);
    return !isNaN(num) && num > 0;
  },
  { message: "Price must be a positive number" },
);

export const quantitySchema = z.string().refine(
  (val) => {
    const num = Number(val);
    return !isNaN(num) && num > 0;
  },
  { message: "Quantity must be a positive number" },
);

export const symbolSchema = z
  .string()
  .min(1, "Symbol is required")
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/, "Symbol must be in format ABC-XYZ");

export const placeOrderSchema = z
  .object({
    symbol: symbolSchema,
    side: z.enum(["buy", "sell"]),
    clientOrderId: z.string().optional(),
    limit: z
      .object({
        price: priceSchema,
        baseSize: quantitySchema.optional(),
        quoteSize: quantitySchema.optional(),
        executionInstructions: z.array(z.string()).optional(),
      })
      .refine(
        (data) => data.baseSize !== undefined || data.quoteSize !== undefined,
        {
          message: "Either baseSize or quoteSize is required for limit orders",
        },
      )
      .optional(),
    market: z
      .object({
        baseSize: quantitySchema.optional(),
        quoteSize: quantitySchema.optional(),
      })
      .refine(
        (data) => data.baseSize !== undefined || data.quoteSize !== undefined,
        {
          message: "Either baseSize or quoteSize is required for market orders",
        },
      )
      .optional(),
  })
  .refine((data) => data.limit !== undefined || data.market !== undefined, {
    message: "Either limit or market configuration is required",
  });
