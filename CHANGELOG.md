# Changelog

## 0.1.0

- Implemented Express.js + Prisma 5 milestone for LeanStock.
- Added full auth baseline: registration, login, logout, refresh tokens, bcrypt, JWT, RBAC.
- Added Redis auth rate limiting and Redis transfer locking.
- Added tenant-scoped catalog, stock adjustment, atomic inventory transfer, and dead-stock decay.
- Added `node-cron` background worker for automatic dead-stock decay.
- Replaced custom Redis lock path with explicit Redis Redlock usage for inventory transfer locking.
- Added seed script and Postman collection requests for ADMIN vs STAFF RBAC demonstration.
- Added final auth flows: email verification, password reset, and refresh token rotation.
- Added BullMQ email and maintenance queues with admin queue visibility.
- Added Redis reservation workflow, sales records, and moving-average reorder forecasting.
- Added minimal frontend demo at `/`.
- OpenAPI contract matches implemented endpoints. No intentional deviations from the blueprint; raw SQL was avoided in application code to satisfy the ORM constraint.
