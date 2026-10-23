import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Enter your username."),
  password: z.string().min(1, "Enter your password."),
  otp: z.union([z.literal(""), z.string().regex(/^\d{6}$/, "Enter a six-digit authenticator code.")]).optional(),
});

export type LoginValues = z.infer<typeof loginSchema>;
