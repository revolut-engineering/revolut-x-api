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

export const orderTriggerConfigSchema = z.object({
  triggerPrice: priceSchema,
  type: z.enum(["market", "limit"]).optional(),
  limitPrice: priceSchema.optional(),
  timeInForce: z.enum(["gtc", "ioc"]).optional(),
  executionInstructions: z.array(z.string()).optional(),
});

export const replaceTriggerConfigSchema = z.object({
  triggerPrice: priceSchema,
});

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
        timeInForce: z.enum(["gtc", "ioc"]).optional(),
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
    tpsl: z
      .object({
        baseSize: quantitySchema.optional(),
        quoteSize: quantitySchema.optional(),
        takeProfit: orderTriggerConfigSchema.optional(),
        stopLoss: orderTriggerConfigSchema.optional(),
      })
      .refine(
        (data) => data.baseSize !== undefined || data.quoteSize !== undefined,
        {
          message: "Either baseSize or quoteSize is required for tpsl orders",
        },
      )
      .refine(
        (data) => data.takeProfit !== undefined || data.stopLoss !== undefined,
        {
          message:
            "At least one of takeProfit or stopLoss is required for tpsl orders",
        },
      )
      .optional(),
  })
  .refine(
    (data) =>
      data.limit !== undefined ||
      data.market !== undefined ||
      data.tpsl !== undefined,
    {
      message: "Either limit, market, or tpsl configuration is required",
    },
  );

export const replaceOrderSchema = z
  .object({
    clientOrderId: z.string().min(1, "clientOrderId is required"),
    price: priceSchema.optional(),
    baseSize: quantitySchema.optional(),
    quoteSize: quantitySchema.optional(),
    timeInForce: z.enum(["gtc", "ioc"]).optional(),
    executionInstructions: z.array(z.string()).optional(),
    takeProfit: replaceTriggerConfigSchema.optional(),
    stopLoss: replaceTriggerConfigSchema.optional(),
  })
  .refine(
    (data) =>
      data.price !== undefined ||
      data.baseSize !== undefined ||
      data.quoteSize !== undefined ||
      data.timeInForce !== undefined ||
      data.executionInstructions !== undefined ||
      data.takeProfit !== undefined ||
      data.stopLoss !== undefined,
    {
      message:
        "At least one of price, baseSize, quoteSize, timeInForce, executionInstructions, takeProfit, or stopLoss must be provided",
    },
  );
