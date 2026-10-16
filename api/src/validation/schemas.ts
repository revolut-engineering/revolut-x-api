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

export const placementReplySchema = z.object({
  data: z.object({
    venue_order_id: z.string().min(1),
    client_order_id: z.string().min(1),
    state: z.string().min(1),
  }),
});

const conditionalOrderSchema = z
  .object({
    triggerPrice: priceSchema,
    limitPrice: priceSchema.optional(),
    baseSize: quantitySchema.optional(),
    quoteSize: quantitySchema.optional(),
  })
  .refine(
    (data) => (data.baseSize !== undefined) !== (data.quoteSize !== undefined),
    {
      message:
        "Exactly one of baseSize or quoteSize is required for conditional orders",
    },
  );

const tpslLegSchema = z.object({
  triggerPrice: priceSchema,
  limitPrice: priceSchema.optional(),
});

const tpslOrderSchema = z
  .object({
    baseSize: quantitySchema,
    takeProfit: tpslLegSchema.optional(),
    stopLoss: tpslLegSchema.optional(),
  })
  .refine(
    (data) => data.takeProfit !== undefined || data.stopLoss !== undefined,
    {
      message:
        "At least one of takeProfit or stopLoss is required for tpsl orders",
    },
  );

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
    conditional: conditionalOrderSchema.optional(),
    tpsl: tpslOrderSchema.optional(),
  })
  .refine(
    (data) => {
      const configs = [
        data.limit,
        data.market,
        data.conditional,
        data.tpsl,
      ].filter((config) => config !== undefined);
      return configs.length === 1;
    },
    {
      message:
        "Exactly one of limit, market, conditional, or tpsl configuration is required",
    },
  );

const replaceTriggerSchema = z.object({
  triggerPrice: priceSchema,
  limitPrice: priceSchema.optional(),
});

export const replaceOrderSchema = z
  .object({
    clientOrderId: z.string().min(1, "clientOrderId is required"),
    price: priceSchema.optional(),
    baseSize: quantitySchema.optional(),
    quoteSize: quantitySchema.optional(),
    timeInForce: z.enum(["gtc", "ioc"]).optional(),
    executionInstructions: z.array(z.string()).optional(),
    conditional: replaceTriggerSchema.nullable().optional(),
    takeProfit: replaceTriggerSchema.nullable().optional(),
    stopLoss: replaceTriggerSchema.nullable().optional(),
  })
  .refine(
    (data) =>
      data.price !== undefined ||
      data.baseSize !== undefined ||
      data.quoteSize !== undefined ||
      data.timeInForce !== undefined ||
      data.executionInstructions !== undefined ||
      data.conditional !== undefined ||
      data.takeProfit !== undefined ||
      data.stopLoss !== undefined,
    {
      message:
        "At least one of price, baseSize, quoteSize, timeInForce, executionInstructions, conditional, takeProfit, or stopLoss must be provided",
    },
  );
