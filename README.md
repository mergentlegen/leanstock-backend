# LeanStock Backend

Production-style backend for LeanStock: Express.js, Prisma 5, PostgreSQL 15, Redis, JWT auth, RBAC, tenant isolation, inventory transfer transactions, reservations, reorder forecasting, async email, and dead-stock price decay.

## Quick Start

1. Copy environment template:

```bash
cp .env.example .env
```

2. Start the full stack:

```bash
docker compose up --build
```

3. Open Swagger UI:

```text
http://localhost:3000/docs
```

Minimal browser demo:

```text
http://localhost:3000
```

Health check:

```text
GET http://localhost:3000/health
```

## Implemented Scope

- Auth: register, email verification, login, refresh token rotation, logout, password reset, `/auth/me`.
- Security: bcrypt password hashing, JWT access tokens, persisted refresh tokens with revocation, RBAC middleware, Redis-backed auth rate limiting.
- LeanStock core: tenant-scoped locations, products, stock adjustment, atomic transfer, Redis reservation, sales recording, reorder forecast, dead-stock decay job.
- Background jobs: dead-stock decay is scheduled by `node-cron` into BullMQ and can also be triggered manually for defense demos.
- Email jobs: verification, password reset, transfer, reservation, and reorder emails are queued asynchronously through BullMQ.
- Multi-tenancy: business tables include `tenantId`; every product/location/inventory query filters by authenticated user tenant.
- Queue visibility: admins can inspect email and maintenance queue state at `/admin/jobs`.
- API docs: OpenAPI 3 contract served at `/docs`.
- Tests: unit tests for decay math, auth integration tests, inventory transaction integration test.

## Architecture Decisions

Express.js was chosen because the Week 1 backend track is Node.js, and Prisma 5 gives a type-safe ORM over PostgreSQL without raw SQL in application code. PostgreSQL is required for ACID inventory updates. Redis is used for rate limiting, Redlock transfer/reservation locks, BullMQ email jobs, and maintenance jobs.

The inventory transfer endpoint does not use raw `SELECT FOR UPDATE` because the assignment bans raw SQL queries. Instead, it uses:

- Redis Redlock keys per `tenantId + productId + locationId` to serialize competing transfers.
- Prisma `$transaction` with `Serializable` isolation.
- Atomic `updateMany` conditional decrement: source stock is decremented only when `quantity >= requestedQuantity`.

That combination prevents overselling while staying inside Prisma ORM.

## Local Commands

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run dev
npm test
npm run lint
```

For local tests, PostgreSQL must be available at `DATABASE_URL`. Docker Compose provides the expected Postgres and Redis services.

Reliable Docker test command:

```bash
docker compose up -d postgres redis
docker compose run --rm -T --entrypoint npm api test
```

Seed defense users:

```bash
docker compose exec api npm run seed
```

Seeded accounts:

```text
admin@leanstock.local / AdminPass1!  role ADMIN
user@leanstock.local  / UserPass1!   role STAFF
```

## Email

Local mode logs email contents to API logs:

```env
EMAIL_DRIVER=log
```

Real SMTP mode for pre-defense:

```env
EMAIL_DRIVER=smtp
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-user
SMTP_PASS=your-password
EMAIL_FROM=LeanStock <no-reply@yourdomain.com>
```

Email sending is asynchronous: API endpoints enqueue jobs into Redis/BullMQ, and the email worker sends them.

## Defense Flow

Recommended Postman tabs:

1. `POST /auth/register`
2. `POST /auth/login`
3. `GET /auth/me`
4. `POST /auth/refresh`
5. `POST /auth/logout`
6. `POST /locations`
7. `POST /products`
8. `GET /products`
9. `POST /inventory/stock`
10. `POST /inventory/transfers`
11. `POST /jobs/dead-stock-decay`
12. `POST /auth/verify-email`
13. `POST /auth/password-reset/request`
14. `POST /auth/password-reset/confirm`
15. `POST /inventory/reservations`
16. `POST /sales`
17. `GET /products/{productId}/forecast`
18. `GET /admin/jobs`

Final Postman collection:

```text
postman/LeanStock_Final_API.postman_collection.json
```

## Environment

The app validates required variables on boot using Zod. Missing `DATABASE_URL`, `REDIS_URL`, JWT secrets, or CORS origins stops startup. Production CORS rejects wildcard origins.

## CI/CD

`.github/workflows/ci.yml` starts PostgreSQL and Redis, installs dependencies, generates Prisma Client, applies migrations, runs lint/tests, and builds the Docker image.
