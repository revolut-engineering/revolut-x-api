import { z } from "zod";

export const RevolutXConfigSchema = z.object({
  api_key: z
    .string()
    .default("")
    .refine(
      (val) => val === "" || (val.length === 64 && /^[a-zA-Z0-9]+$/.test(val)),
      { message: "API key must be 64 alphanumeric characters" },
    ),
  private_key_path: z.string().default(""),
});

export type RevolutXConfig = z.infer<typeof RevolutXConfigSchema>;
