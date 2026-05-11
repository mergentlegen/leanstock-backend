const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  CORS_ORIGINS: z.string().min(1),
  AUTH_RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(5),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  TRANSFER_LOCK_TTL_MS: z.coerce.number().int().positive().default(8000),
  ENABLE_DEAD_STOCK_WORKER: z.coerce.boolean().default(true),
  DEAD_STOCK_DECAY_CRON: z.string().min(5).default("0 * * * *"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  EMAIL_DRIVER: z.enum(["log", "smtp"]).default("log"),
  EMAIL_FROM: z.string().min(3).default("LeanStock <no-reply@leanstock.local>"),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  LOW_STOCK_THRESHOLD_DAYS: z.coerce.number().int().positive().default(5),
}).superRefine((value, ctx) => {
  if (value.EMAIL_DRIVER === "smtp" && (!value.SMTP_HOST || !value.SMTP_USER || !value.SMTP_PASS)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "SMTP_HOST, SMTP_USER, and SMTP_PASS are required when EMAIL_DRIVER=smtp",
      path: ["EMAIL_DRIVER"],
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${message}`);
}

const env = parsed.data;
env.CORS_ORIGIN_LIST = env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);

if (env.NODE_ENV === "production" && env.CORS_ORIGIN_LIST.includes("*")) {
  throw new Error("CORS_ORIGINS cannot contain wildcard '*' in production.");
}

module.exports = { env };
