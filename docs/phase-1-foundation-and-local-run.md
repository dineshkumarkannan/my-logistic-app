# Phase 1 — Modular Monolith Foundation and Enterprise Authentication

## 1. Phase purpose

Phase 1 establishes the technical foundation for the logistics platform. The goal is not to build freight operations yet. The goal is to create a reliable application boundary where future domains such as shipments, carriers, vehicles, dispatching, billing, and tracking can be added without turning the codebase into one large collection of unrelated routes and database queries.

This phase introduces:

- a Node.js and Express API written in TypeScript
- a modular-monolith structure
- Clean Architecture-inspired separation of responsibilities
- PostgreSQL as the relational system of record
- Prisma as the database access and migration tool
- Redis as the active-session store
- tenant-aware users and roles
- password hashing and JWT authentication
- centralized error handling
- request validation with Zod
- API documentation with OpenAPI and Swagger UI
- local infrastructure configuration with Docker Compose
- a build and type-checking pipeline

## 2. Learning objectives

By completing this phase, you should understand:

1. How an Express application is bootstrapped.
2. Why TypeScript compiler rules matter in a growing backend.
3. How a modular monolith differs from a folder-by-featureless application.
4. Why controllers, services, and repositories have different responsibilities.
5. How a request travels through middleware, routes, controllers, services, and repositories.
6. How PostgreSQL and Redis serve different purposes.
7. How tenant identity must travel with an authenticated request.
8. Why passwords must be hashed and never stored as plaintext.
9. How access tokens, refresh tokens, cookies, and Redis sessions work together.
10. Why errors and validation should be handled at application boundaries.

## 3. Technology choices

| Technology     | Responsibility                 | Reason for using it                                                         |
| -------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Node.js        | JavaScript runtime             | Good fit for I/O-heavy APIs and a large ecosystem                           |
| Express        | HTTP server and routing        | Small, explicit, and easy to understand while learning backend architecture |
| TypeScript     | Static type checking           | Detects many integration mistakes before runtime                            |
| PostgreSQL     | Relational persistence         | Strong transactions, constraints, indexes, and relational modeling          |
| Prisma         | Database client and migrations | Type-safe access to PostgreSQL from TypeScript                              |
| Redis          | Fast session state             | Suitable for short-lived, frequently checked authentication state           |
| Zod            | Runtime validation             | TypeScript types disappear at runtime; Zod validates real HTTP input        |
| bcryptjs       | Password hashing               | Passwords are stored as slow one-way hashes rather than reversible values   |
| JSON Web Token | Access-token format            | Carries signed authentication claims between requests                       |
| Swagger UI     | API exploration                | Makes the OpenAPI contract visible and testable in a browser                |

## 4. Architecture style

### 4.1 Modular monolith

The application is one deployable Node.js process, but its code is divided into business modules. The current module is `auth`.

```text
src/
├── config/                  Shared infrastructure configuration
├── middlewares/             Cross-cutting HTTP behavior
├── modules/
│   └── auth/                Authentication business boundary
│       ├── controllers/     HTTP request/response mapping
│       ├── dtos/            Runtime input schemas and input types
│       ├── middlewares/     Authentication and authorization guards
│       ├── repositories/    Database access
│       ├── services/        Business orchestration
│       └── auth.routes.ts   HTTP endpoint definitions
├── docs/                    OpenAPI source and learning documentation
├── app.ts                   Express application configuration
└── server.ts                Process startup and shutdown
```

The important boundary is this:

```text
HTTP request
  ↓
Middleware
  ↓
Route
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
PostgreSQL / Redis
```

### 4.2 Clean Architecture responsibilities

#### Controller

The controller translates HTTP concerns into application calls. It should know about requests, responses, cookies, and status codes. It should not contain SQL queries or password policy logic.

#### Service

The service contains business orchestration. In this phase it coordinates password hashing, credential checks, token creation, tenant onboarding, and Redis session creation.

#### Repository

The repository isolates persistence. The auth service does not need to know whether a user came from Prisma, raw SQL, or another data source.

#### Middleware

Middleware runs before or after route handlers. Validation, authentication, authorization, rate limiting, and error conversion are cross-cutting concerns that should not be duplicated inside every controller.

## 5. Activities completed

### Activity 1 — Initialized the Node.js project

The project was initialized with npm and configured with runtime and development dependencies.

Important scripts:

```json
{
  "dev": "tsx watch src/server.ts",
  "build": "tsc",
  "start": "node dist/server.js",
  "typecheck": "tsc --noEmit",
  "prisma:generate": "prisma generate",
  "prisma:migrate": "prisma migrate dev"
}
```

`typecheck` checks the code without producing JavaScript. `build` produces the compiled output in `dist/`. Keeping both scripts is useful: type checking is fast feedback, while building verifies that the application can be emitted for execution.

### Activity 2 — Added strict TypeScript configuration

The compiler uses strict checking, ES2022 language features, CommonJS-compatible output, consistent filename casing, and a clean `src` to `dist` mapping.

Important ideas:

- `strict` enables a family of safety checks.
- `noImplicitAny` prevents silently untyped values.
- `strictNullChecks` forces the code to handle missing values explicitly.
- `rootDir` identifies source code.
- `outDir` identifies compiled code.
- `skipLibCheck` avoids checking every declaration file inside dependencies.

The installed TypeScript version no longer accepts the old `moduleResolution: "node"` and `baseUrl` options from the initial example, so those obsolete settings were removed while preserving strict CommonJS-compatible compilation.

### Activity 3 — Added local infrastructure

`docker-compose.yml` defines:

- PostgreSQL 15 on port `5432`
- Redis 7 on port `6379`
- named volumes so container restarts do not immediately remove data

The local `.env` file connects the application to these services. It is excluded from version control through `.gitignore`.

Never commit real production secrets to `.env`, source code, CI logs, or documentation. The values in this project are development-only placeholders.

### Activity 4 — Designed the relational schema

The schema contains four important concepts:

#### Tenant

A tenant represents an organization using the logistics platform. In a future production system, a tenant might represent a shipper, carrier, broker, or logistics organization.

`deletedAt` supports a soft-delete policy. Instead of immediately deleting the row, the application can mark it as deleted and preserve history for auditing or recovery.

#### User

A user belongs to a tenant through `tenantId`. The user stores a password hash, identity fields, active state, role, and timestamps.

The current roles are:

- `SUPER_ADMIN`
- `ORG_MANAGER`
- `DISPATCHER`
- `DRIVER`

#### RefreshToken

The model is prepared for database-backed refresh-token persistence. The current login flow stores the active refresh session in Redis; the model allows a later phase to add token rotation, audit history, and persistent revocation records.

#### Indexes

Indexes were added for frequently filtered values:

- tenant active state
- user tenant membership
- user email and active state
- refresh-token ownership and expiry

An index improves lookup speed, but it also adds write and storage overhead. Indexes should follow real query patterns rather than being added to every column automatically.

### Activity 5 — Implemented tenant onboarding

Registration accepts:

```json
{
  "tenantName": "Acme Logistics Group",
  "email": "admin@acmelogistics.com",
  "password": "SecurePassword123!",
  "firstName": "John",
  "lastName": "Doe"
}
```

The repository creates the tenant and its first organization manager inside one Prisma transaction.

That transaction matters because tenant creation and owner creation are one business operation. If user creation fails, the tenant creation should also be rolled back instead of leaving an unusable empty tenant behind.

The first registered user receives the `ORG_MANAGER` role. This is appropriate for a learning flow, but a production onboarding process would normally add invitations, approval rules, email verification, and stronger organization-creation controls.

### Activity 6 — Implemented password security

The service generates a salt and hashes passwords with bcrypt before persistence:

```text
plain password → bcrypt hash → database
```

During login:

```text
submitted password + stored hash → bcrypt comparison → allow or reject
```

The application never needs to decrypt a password. A password hash is deliberately one-way. Login failures use a generic credential message so the API does not reveal whether an email exists.

### Activity 7 — Implemented dual-token authentication

Login creates:

- an access token for API authorization
- a refresh token stored in an `HttpOnly` cookie
- a Redis session entry keyed by tenant and user

The access token contains the user identity, tenant identity, role, and email. It is short-lived. The refresh token has a longer lifetime and is not returned as ordinary response JSON.

The refresh cookie uses:

- `httpOnly: true` so browser JavaScript cannot read it
- `secure: true` in production so it is sent only over HTTPS
- `sameSite: "strict"` to reduce cross-site request abuse
- a seven-day maximum age in the current learning implementation

The current phase creates and stores refresh tokens, but a dedicated refresh-token rotation endpoint is still a future improvement.

### Activity 8 — Added Redis session revocation

The login flow writes a session entry:

```text
session:<tenantId>:<userId> → refresh token
```

The JWT guard verifies both:

1. the cryptographic signature and claims of the access token
2. the existence of the user session in Redis

This means logout can delete the Redis session and cause future protected requests to fail even if the access token has not reached its natural expiry time.

This is a useful learning pattern for centralized revocation. In a more advanced implementation, the Redis value should be a hash or session identifier rather than a raw refresh token, and multiple concurrent sessions should be modeled separately.

### Activity 9 — Added request validation

Zod schemas validate request bodies before controllers execute. For example, registration validates email format, password length, tenant-name length, and name length.

Validation is runtime protection. TypeScript alone cannot protect the API because external JSON requests do not carry TypeScript types.

Invalid input is converted into an `AppError` containing field-level details, then passed to the centralized error handler.

### Activity 10 — Added centralized error handling

`AppError` represents expected operational failures such as:

- invalid credentials
- validation failure
- missing authentication
- insufficient authorization
- duplicate account conditions

The global error handler:

- logs the request method, path, and error internally
- returns stack traces and operational metadata in development
- hides internal details in production
- ensures errors from async handlers reach one consistent response boundary

`catchAsync` removes repetitive `try/catch` blocks from route handlers by forwarding rejected promises to the global handler.

## 6. Request flows

### 6.1 Registration flow

```text
POST /api/v1/auth/register
  ↓
validateBody(RegisterTenantSchema)
  ↓
AuthController.register
  ↓
AuthService.register
  ↓
bcrypt password hash
  ↓
AuthRepository.createTenantWithAdmin
  ↓
Prisma transaction
  ├── create Tenant
  └── create ORG_MANAGER User
```

### 6.2 Login flow

```text
POST /api/v1/auth/login
  ↓
validateBody(LoginSchema)
  ↓
find active, non-deleted user
  ↓
bcrypt password comparison
  ↓
create access JWT
  ↓
create refresh JWT
  ↓
store session in Redis
  ↓
set HttpOnly refresh cookie
  ↓
return access token and safe user data
```

### 6.3 Protected request flow

```text
Authorization: Bearer <access-token>
  ↓
verifyJwtGuard
  ↓
verify JWT signature and claims
  ↓
check session:<tenantId>:<userId> in Redis
  ↓
attach req.user
  ↓
controller or RBAC guard
```

### 6.4 Logout flow

```text
POST /api/v1/auth/logout
  ↓
verifyJwtGuard
  ↓
delete Redis session
  ↓
clear refresh-token cookie
```

## 7. File responsibilities

| File                                               | Responsibility                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/app.ts`                                       | Creates Express app, registers security middleware, routes, Swagger, and error handler |
| `src/server.ts`                                    | Loads infrastructure connections and starts the HTTP listener                          |
| `src/config/environment.ts`                        | Validates environment variables with Zod                                               |
| `src/config/database.ts`                           | Exports the Prisma singleton                                                           |
| `src/config/redis.ts`                              | Exports the Redis client and connection helper                                         |
| `src/middlewares/error.middleware.ts`              | Defines `AppError` and global error responses                                          |
| `src/middlewares/catchAsync.ts`                    | Forwards async route failures to Express error handling                                |
| `src/middlewares/validate.middleware.ts`           | Validates request bodies and request envelopes                                         |
| `src/modules/auth/dtos/auth.dto.ts`                | Defines registration and login schemas                                                 |
| `src/modules/auth/repositories/auth.repository.ts` | Reads users and atomically creates tenant/admin records                                |
| `src/modules/auth/services/auth.service.ts`        | Orchestrates registration, login, sessions, and logout                                 |
| `src/modules/auth/controllers/auth.controller.ts`  | Maps auth use cases to HTTP responses and cookies                                      |
| `src/modules/auth/middlewares/auth.middleware.ts`  | Verifies JWTs and active Redis sessions                                                |
| `src/modules/auth/middlewares/rbac.middleware.ts`  | Restricts routes by `UserRole`                                                         |
| `src/modules/auth/auth.routes.ts`                  | Defines authentication endpoints                                                       |
| `prisma/schema.prisma`                             | Defines PostgreSQL models, relationships, enums, and indexes                           |
| `src/docs/openapi.yaml`                            | Documents the public auth API                                                          |
| `docker-compose.yml`                               | Defines local PostgreSQL and Redis services                                            |

## 8. How to run Phase 1

### Prerequisites

- Node.js 22 or later
- npm
- Docker Desktop or another Docker Engine with Compose support

### Install dependencies

```bash
npm install
```

### Start infrastructure

```bash
docker compose up -d
```

### Create and apply the database migration

```bash
npx prisma migrate dev --name init_system
```

This creates the migration from `prisma/schema.prisma`, applies it to the local PostgreSQL database, and regenerates Prisma Client.

### Start development mode

```bash
npm run dev
```

The API should be available at:

- API: `http://localhost:5001`
- Health check: `http://localhost:5001/health`
- Swagger UI: `http://localhost:5001/api/docs`

## 9. Manual API test sequence

### Register a tenant and organization manager

```bash
curl -i -X POST http://localhost:5001/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantName": "Acme Logistics Group",
    "email": "admin@acmelogistics.com",
    "password": "SecurePassword123!",
    "firstName": "John",
    "lastName": "Doe"
  }'
```

### Log in

```bash
curl -i -c cookies.txt -X POST http://localhost:5001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "admin@acmelogistics.com",
    "password": "SecurePassword123!"
  }'
```

Copy the `token` value from the response.

### Log out

```bash
curl -i -b cookies.txt -X POST http://localhost:5001/api/v1/auth/logout \
  -H 'Authorization: Bearer <access-token>'
```

### Test validation failure

```bash
curl -i -X POST http://localhost:5001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"not-an-email","password":""}'
```

The response should be a `400` response containing field-level validation details.

## 10. What has been verified in the development workspace

The following checks pass:

```bash
npm run typecheck
npm run build
npx prisma validate
npx prisma generate
```

The application code has not been connected to live PostgreSQL and Redis in this workspace because Docker is unavailable in the current environment. Therefore, the migration and end-to-end HTTP flow still need to be run on a machine with Docker installed.

## 11. Known limitations and future improvements

Phase 1 is a strong learning foundation, but it is not yet production-complete. The next improvements should be deliberate exercises rather than hidden assumptions.

### Authentication improvements

- Add a refresh-token endpoint
- Rotate refresh tokens after every use
- Hash refresh tokens before storing them in Redis or PostgreSQL
- Support multiple sessions per user and device-level logout
- Add email verification
- Add password reset with one-time expiring tokens
- Add account lockout or progressive delay after repeated failures

### Multi-tenancy improvements

- Decide whether email uniqueness is global or tenant-specific
- Add explicit tenant context checks to every future repository query
- Add tenant lifecycle and invitation workflows
- Add audit events for authentication and administrative actions

### Authorization improvements

- Separate roles from permissions
- Add a permission catalog such as `shipment.read` and `shipment.assign`
- Test every role against every protected operation
- Avoid accepting tenant identifiers directly from untrusted request bodies when they can be derived from the authenticated context

### Reliability improvements

- Add automated unit and integration tests
- Add graceful HTTP server shutdown in addition to database shutdown
- Add structured logging with request IDs
- Add health and readiness endpoints that check dependencies
- Add Redis retry and reconnect policy
- Add database connection and query metrics

### API and operations improvements

- Add a refresh endpoint to the OpenAPI document
- Version error codes and response envelopes
- Add CI test execution, not only type checking
- Add container health checks to Docker Compose
- Add a production secrets strategy

## 12. Phase completion checklist

- [x] Node.js project initialized
- [x] TypeScript compiler configured
- [x] Express application created
- [x] Modular monolith structure created
- [x] PostgreSQL and Redis Compose configuration created
- [x] Prisma tenant/user/RBAC schema created
- [x] Soft-delete fields added
- [x] Database indexes added
- [x] Centralized error handling added
- [x] Async error wrapper added
- [x] Zod request validation added
- [x] Tenant-admin registration added
- [x] Password hashing added
- [x] JWT access and refresh tokens added
- [x] Redis session revocation added
- [x] JWT and Redis session guard added
- [x] Role authorization middleware added
- [x] Swagger UI and OpenAPI specification added
- [x] Typecheck and build passing
- [ ] Docker services started locally
- [ ] Initial Prisma migration applied locally
- [ ] End-to-end HTTP flow executed locally
