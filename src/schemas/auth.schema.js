const { z } = require("zod");

const strongPassword = z.string()
  .min(10)
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^A-Za-z0-9]/, "Password must contain a special character");

const registerSchema = z.object({
  body: z.object({
    tenantName: z.string().min(2).max(120),
    email: z.string().email().toLowerCase(),
    username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_]+$/),
    password: strongPassword,
    role: z.enum(["MERCHANT", "STAFF"]).optional(),
  }),
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email().toLowerCase(),
    password: z.string().min(1),
  }),
});

const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(32),
  }),
});

const logoutSchema = refreshSchema;

const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(32),
  }).optional(),
  query: z.object({
    token: z.string().min(32).optional(),
  }).optional(),
}).refine((value) => value.body?.token || value.query?.token, {
  message: "Verification token is required",
});

const passwordResetRequestSchema = z.object({
  body: z.object({
    email: z.string().email().toLowerCase(),
  }),
});

const passwordResetConfirmSchema = z.object({
  body: z.object({
    token: z.string().min(32),
    newPassword: strongPassword,
  }),
});

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  verifyEmailSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
};
