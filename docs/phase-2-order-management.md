# Phase 2 — Core Order Management System

## 1. Phase purpose

Phase 2 adds the first logistics operation to the application: order management.
An authenticated organization can create delivery orders, list them efficiently,
and assign a delivery job to a driver.

The most important reliability feature in this phase is optimistic locking. A
dispatcher sends the version of the order they last read. The database updates
the order only when that version is still current. This prevents two concurrent
dispatchers from successfully assigning the same job.

This phase introduces:

- a tenant-scoped `Order` model in PostgreSQL
- an explicit `OrderStatus` enum
- indexes for tenant/status, driver, and creation-time queries
- a version counter for optimistic concurrency control
- Zod validation for order bodies and query parameters
- keyset pagination using a cursor
- an order repository for persistence operations
- an order service for business rules and conflict handling
- authenticated and role-protected order routes
- OpenAPI documentation for the order endpoints

## 2. Learning objectives

By completing this phase, you should understand:

1. How to model an operational order table for a multi-tenant system.
2. Why tenant identifiers must be included in repository queries.
3. Why a status enum is safer than free-form status strings.
4. How database indexes support frequent filtering and sorting patterns.
5. The difference between offset pagination and keyset pagination.
6. How an integer version counter prevents lost updates.
7. Why the version predicate and increment must happen in one database update.
8. How DTO schemas protect HTTP boundaries at runtime.
9. How controllers, services, repositories, and routes work together.
10. How RBAC prevents unauthorized operational actions.
11. How to verify concurrency behavior with real HTTP requests.

## 3. Architecture style

### 3.1 Orders module structure

The application remains a modular monolith. Auth and orders run in the same
Node.js process, but order business code has its own folders and repository.

```text
src/
├── config/
│   └── database.ts                 Shared Prisma database client
├── middlewares/
│   ├── catchAsync.ts               Async error forwarding
│   ├── error.middleware.ts         Centralized error responses
│   └── validate.middleware.ts      Runtime request validation
├── modules/
│   ├── auth/
│   │   ├── controllers/
│   │   ├── dtos/
│   │   ├── middlewares/            JWT guard and RBAC
│   │   ├── repositories/
│   │   ├── services/
│   │   └── auth.routes.ts
│   └── orders/
│       ├── controllers/
│       │   └── order.controller.ts
│       ├── dtos/
│       │   └── order.dto.ts
│       ├── repositories/
│       │   └── order.repository.ts
│       ├── services/
│       │   └── order.service.ts
│       └── order.routes.ts
├── app.ts
└── server.ts
```

### 3.2 Request architecture

```text
HTTP request
    │
    ▼
verifyJwtGuard
    │  Verifies the access token and active Redis session
    ▼
authorizeRoles
    │  Checks the authenticated user's role
    ▼
validate
    │  Validates body, params, or query with Zod
    ▼
OrderController
    │  Maps HTTP data to a use-case call
    ▼
OrderService
    │  Applies business rules and translates conflicts
    ▼
OrderRepository
    │  Executes tenant-scoped Prisma operations
    ▼
PostgreSQL
```

Each layer has one main responsibility:

| Layer | Simple responsibility |
| --- | --- |
| Route | Chooses the endpoint, security guards, and validation schemas |
| Middleware | Performs reusable checks before the controller |
| Controller | Reads HTTP input and formats the HTTP response |
| Service | Applies order workflow and concurrency rules |
| Repository | Reads and writes order records |
| PostgreSQL | Enforces persistence, indexes, and atomic updates |

## 4. Database schema design

### 4.1 Order model

The `Order` model is defined in `prisma/schema.prisma`:

```prisma
model Order {
  id             String      @id @default(uuid())
  tenantId       String
  customerId     String
  driverId       String?
  pickupAddress  String
  dropoffAddress String
  status         OrderStatus @default(PENDING)
  version        Int         @default(1)
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt
  deletedAt      DateTime?

  @@index([tenantId, status])
  @@index([driverId])
  @@index([createdAt])
}
```

### 4.2 Field descriptions

| Field | Description |
| --- | --- |
| `id` | Unique UUID for the order |
| `tenantId` | Organization partition key; every order query uses it |
| `customerId` | UUID reference to the customer or billing profile |
| `driverId` | Optional UUID reference to the assigned driver |
| `pickupAddress` | Address where the order is collected |
| `dropoffAddress` | Address where the order is delivered |
| `status` | Controlled operational state |
| `version` | Current optimistic-lock snapshot number |
| `createdAt` | Creation timestamp used for ordering |
| `updatedAt` | Automatically updated modification timestamp |
| `deletedAt` | Nullable soft-delete timestamp |

`customerId` and `driverId` are strings rather than hard database foreign keys.
This keeps the order boundary independent from customer and driver schemas. The
application can later validate those references through a service or another
microservice without coupling the order database to those tables.

### 4.3 Order status enum

```prisma
enum OrderStatus {
  PENDING
  ASSIGNED
  IN_TRANSIT
  COMPLETED
  CANCELLED
}
```

An enum prevents accidental values such as `ASSIGNEDD`, `complete`, or
`delivered-successfully` from entering the operational data.

The current Phase 2 workflow uses:

```text
PENDING ──assign driver──▶ ASSIGNED
```

The remaining statuses are part of the domain model for later driver tracking
and delivery workflow phases.

### 4.4 Indexes

The schema creates three indexes:

- `tenantId, status`: supports tenant order queues filtered by status.
- `driverId`: supports finding jobs assigned to a driver.
- `createdAt`: supports time-ordered operational listings.

An index is an additional data structure PostgreSQL can use to locate rows
without examining every row in the table. Indexes improve reads but add storage
and write-maintenance cost, so they should follow real query patterns.

The database query planner decides whether an index is worthwhile. On a tiny
development table it may choose a sequential scan because that is cheaper. At
production volumes, inspect the plan with `EXPLAIN ANALYZE` rather than assuming
an index is always selected.

## 5. DTOs and runtime validation

The order DTOs live in `src/modules/orders/dtos/order.dto.ts`.
TypeScript types help during compilation, but HTTP clients send untyped JSON.
Zod validates the real runtime payload before the controller runs.

### 5.1 Create order body

```typescript
export const CreateOrderSchema = z.object({
  customerId: z.string().uuid(),
  pickupAddress: z.string().trim().min(5),
  dropoffAddress: z.string().trim().min(5),
});
```

Rules:

- `customerId` must be a valid UUID.
- Both addresses must contain at least five characters.
- Leading and trailing address whitespace is removed.
- Unknown fields are not needed by the current create contract.

Valid body:

```json
{
  "customerId": "550e8400-e29b-41d4-a716-446655440000",
  "pickupAddress": "Warehouse 12, Bengaluru",
  "dropoffAddress": "Customer office, Hyderabad"
}
```

### 5.2 Driver assignment body

```typescript
export const AssignDriverSchema = z.object({
  driverId: z.string().uuid(),
  currentVersion: z.number().int().positive(),
});
```

`currentVersion` is required because the client must identify the exact order
snapshot it is trying to change.

```json
{
  "driverId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "currentVersion": 1
}
```

### 5.3 List query

```typescript
export const GetOrdersQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(10),
  cursor: z.string().uuid().optional(),
});
```

Query-string values arrive as strings. `z.coerce.number()` changes `limit=5`
from the string `"5"` into the number `5`. The limit is capped at 100 to stop
one request from attempting to load an unreasonable number of records.

The `cursor` is the ID of the last order returned by the previous page.

## 6. Keyset pagination

### 6.1 Why pagination is necessary

Returning every order in one response becomes expensive as a tenant grows.
Pagination limits the number of rows read and transferred per request.

Offset pagination looks like this:

```text
page 1: OFFSET 0  LIMIT 10
page 2: OFFSET 10 LIMIT 10
page 3: OFFSET 20 LIMIT 10
```

For deep pages, PostgreSQL may still walk past many earlier rows before
returning the requested page.

Keyset pagination uses a known row as the starting point:

```text
page 1: take 10 rows
page 2: start after cursor ID from page 1, take 10 rows
page 3: start after cursor ID from page 2, take 10 rows
```

The repository implements this with Prisma:

```typescript
return prisma.order.findMany({
  take: limit,
  skip: cursor ? 1 : 0,
  cursor: cursor ? { id: cursor } : undefined,
  where: {
    tenantId,
    status: status || undefined,
    deletedAt: null,
  },
  orderBy: { createdAt: "desc" },
});
```

`skip: 1` removes the cursor row itself from the next page. The service returns
the final row ID as `nextCursor` when the page is full:

```typescript
const nextCursor = orders.length === limit
  ? orders[orders.length - 1]?.id ?? null
  : null;
```

If fewer records than the requested limit are returned, there is no next page
and `nextCursor` is `null`.

For a very large production system, a composite cursor containing both
`createdAt` and `id` can provide deterministic ordering when many rows share an
identical timestamp. The current implementation follows the requested ID
cursor contract.

## 7. Optimistic locking

### 7.1 Simple explanation

Optimistic locking assumes concurrent writes are uncommon and avoids holding a
long database lock while a user edits a record.

The client reads:

```text
order.version = 1
```

It later sends:

```json
{
  "driverId": "driver-uuid",
  "currentVersion": 1
}
```

The repository performs one conditional update:

```text
UPDATE Order
SET driverId = ?, status = 'ASSIGNED', version = version + 1
WHERE id = ?
  AND tenantId = ?
  AND version = 1
  AND deletedAt IS NULL
```

If the row still has version 1, PostgreSQL updates exactly one row and the
version becomes 2. If another request already changed it, the predicate matches
zero rows.

### 7.2 Concurrent request timeline

```text
Dispatcher A reads version 1 ───────────────┐
                                            │
Dispatcher B reads version 1 ───────────────┤
                                            │
A: UPDATE ... WHERE version = 1 ──▶ count 1 │──▶ HTTP 200, version 2
                                            │
B: UPDATE ... WHERE version = 1 ──▶ count 0 │──▶ HTTP 409 Conflict
```

The database makes the decision atomically. The application does not use a
separate "check, then update" transaction that could allow both requests to
pass the check.

### 7.3 Repository implementation

```typescript
const updateResult = await prisma.order.updateMany({
  where: {
    id: orderId,
    tenantId,
    deletedAt: null,
    version: expectedVersion,
  },
  data: {
    ...newData,
    version: { increment: 1 },
  },
});

if (updateResult.count === 0) return null;
```

The service converts a `null` result into an HTTP `409` response:

```text
CONCURRENCY_CONFLICT: The order data was modified by another operator.
Please refresh and retry.
```

The service also checks a freshly read order version before validating the
workflow state. This ensures a stale assignment receives `409` even if another
dispatcher has already changed the status to `ASSIGNED`.

## 8. Repository layer

`src/modules/orders/repositories/order.repository.ts` contains four persistence
operations:

| Method | Purpose |
| --- | --- |
| `createOrder` | Creates a pending order within the authenticated tenant |
| `findById` | Finds one non-deleted order within a tenant |
| `findPaginated` | Returns a cursor-based tenant order page |
| `updateOrderWithLock` | Performs the atomic version-checked update |

Every read and update includes `tenantId`. This prevents an authenticated user
from using a valid order ID belonging to another organization.

The repository returns database records and does not decide whether an order is
allowed to move from one business state to another. That decision belongs in the
service.

## 9. Service layer

`src/modules/orders/services/order.service.ts` coordinates the use cases.

### Create

The service forwards validated order data and the authenticated tenant ID to the
repository. The tenant ID comes from the JWT claims, not from the request body.

### List

The service converts the validated status into the Prisma enum, calls the
repository, and calculates `nextCursor` from the final row.

### Assign driver

The workflow is:

```text
1. Find order by ID and tenant ID.
2. Return 404 if it does not exist.
3. Return 409 if currentVersion is stale.
4. Return 400 if the order is not PENDING.
5. Atomically set driverId and ASSIGNED status where version matches.
6. Return 409 if the atomic update affects zero rows.
7. Return the updated order with version incremented by one.
```

The service intentionally does not trust a tenant ID or user identity supplied
by the client. Those values are obtained from `request.user`, which the JWT
middleware populated after verification.

## 10. HTTP routes and authorization

The router is mounted at `/api/v1/orders` in `src/app.ts`.

| Method | Endpoint | Allowed roles | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/orders` | `SUPER_ADMIN`, `ORG_MANAGER`, `DISPATCHER` | Create an order |
| `GET` | `/api/v1/orders` | `SUPER_ADMIN`, `ORG_MANAGER`, `DISPATCHER` | List tenant orders |
| `PATCH` | `/api/v1/orders/:id/assign` | `SUPER_ADMIN`, `DISPATCHER` | Assign a driver with a version check |

All routes first run `verifyJwtGuard`, which verifies the access token and
active Redis session. RBAC then checks the role from the verified token.

The current phase does not expose `GET /api/v1/orders/:id`; list responses
contain the complete order records. A detail endpoint can be added in a later
iteration if the client needs direct single-order retrieval.

## 11. Manual API usage

### 11.1 Log in

```bash
curl -i -X POST http://localhost:5001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "admin@example.com",
    "password": "SecurePassword123!"
  }'
```

Copy the `token` value from the response. Use it as a bearer token on order
requests.

### 11.2 Create an order

```bash
curl -i -X POST http://localhost:5001/api/v1/orders \
  -H 'Authorization: Bearer <access-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "customerId": "550e8400-e29b-41d4-a716-446655440000",
    "pickupAddress": "Warehouse 12, Bengaluru",
    "dropoffAddress": "Customer office, Hyderabad"
  }'
```

The newly created order starts with:

```json
{
  "status": "PENDING",
  "version": 1
}
```

### 11.3 List orders

```bash
curl -i 'http://localhost:5001/api/v1/orders?limit=10' \
  -H 'Authorization: Bearer <access-token>'
```

This is a `GET` request and has no body. A successful response has this shape:

```json
{
  "success": true,
  "orders": [
    {
      "id": "order-uuid",
      "tenantId": "tenant-uuid",
      "customerId": "customer-uuid",
      "driverId": null,
      "pickupAddress": "Warehouse 12, Bengaluru",
      "dropoffAddress": "Customer office, Hyderabad",
      "status": "PENDING",
      "version": 1
    }
  ],
  "nextCursor": "last-order-id-or-null"
}
```

### 11.4 Request the next page

```bash
curl -i 'http://localhost:5001/api/v1/orders?limit=10&cursor=<next-cursor>' \
  -H 'Authorization: Bearer <access-token>'
```

### 11.5 Filter by status

```bash
curl -i 'http://localhost:5001/api/v1/orders?status=PENDING&limit=10' \
  -H 'Authorization: Bearer <access-token>'
```

### 11.6 Assign a driver

The assign route requires a `DISPATCHER` or `SUPER_ADMIN` token:

```bash
curl -i -X PATCH \
  'http://localhost:5001/api/v1/orders/<order-id>/assign' \
  -H 'Authorization: Bearer <dispatcher-access-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "driverId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "currentVersion": 1
  }'
```

The successful response contains `status: "ASSIGNED"` and `version: 2`.

## 12. Local setup and migration

### Start infrastructure

```bash
docker compose up -d
```

This starts the local PostgreSQL and Redis containers defined in
`docker-compose.yml`.

### Generate Prisma Client

```bash
npm run prisma:generate
```

### Create and apply the Phase 2 migration

```bash
npx prisma migrate dev --name add_order_management_and_locking
```

The migration created in this workspace is:

```text
prisma/migrations/20260917034536_add_order_management_and_locking/
```

It creates the `OrderStatus` enum, `Order` table, version default, and three
indexes.

### Start the API

```bash
npm run dev
```

The local endpoints are:

- API: `http://localhost:5001`
- Health: `http://localhost:5001/health`
- Swagger UI: `http://localhost:5001/api/docs`

## 13. Verification scenarios

### Verification 1 — Keyset query

The local verification flow created 15 distinct orders for a temporary test
tenant and executed:

```text
GET /api/v1/orders?limit=5
GET /api/v1/orders?limit=5&cursor=<nextCursor>
```

Observed result:

```text
Page 1: HTTP 200, 5 orders, nextCursor returned
Page 2: HTTP 200, 5 orders, nextCursor returned
Overlap: 0 orders
```

The zero overlap confirms that the cursor row itself is skipped on the next
request.

### Verification 2 — Concurrent assignment

Two requests were launched concurrently against the same pending order. Both
sent `currentVersion: 1` but different driver IDs.

Observed result:

```text
Request 1: HTTP 200, version 2
Request 2: HTTP 409, CONCURRENCY_CONFLICT
```

This proves that both requests did not successfully overwrite the assignment.
Only one request matched `version = 1` in the atomic update.

### Useful role check

An `ORG_MANAGER` can create and list orders but cannot assign a driver. The
assignment route intentionally permits only `SUPER_ADMIN` and `DISPATCHER`.
An unauthorized assignment returns:

```text
HTTP 403
You do not have permission to access this resource
```

## 14. Problems found and fixes

### Problem 1 — Express 5 query property

The shared validator originally attempted to assign a new object to
`request.query`. Express 5 exposes that property through a read-only getter,
which caused:

```text
Cannot set property query of #<IncomingMessage> which has only a getter
```

The validator now stores the parsed query in `response.locals.validatedQuery`,
and the order controller reads the validated, transformed query from there.

### Problem 2 — Query values remained strings

Mutating the object returned by `request.query` did not reliably affect later
reads. The repository received `take: "5"` instead of `take: 5` and Prisma
rejected the request.

Using `response.locals.validatedQuery` preserves Zod coercion and defaults.

### Problem 3 — Stale assignment could return 400

If one concurrent assignment completed before the other request performed its
workflow check, the second request saw `ASSIGNED` and could return a normal
workflow error instead of a concurrency error.

The service now checks `order.version !== currentVersion` first. A stale client
snapshot consistently receives HTTP 409.

### Problem 4 — Incorrect HTTP request shape

The order list endpoint is `GET`, not `POST`, and it has no body. The create
endpoint expects the fields directly in a JSON object, not inside a nested
`body` property:

```json
{
  "customerId": "...",
  "pickupAddress": "...",
  "dropoffAddress": "..."
}
```

The request must also use `Content-Type: application/json`.

## 15. File responsibilities

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | Defines `Order`, `OrderStatus`, and indexes |
| `prisma/migrations/20260917034536_add_order_management_and_locking/migration.sql` | Creates the Phase 2 database objects |
| `src/modules/orders/dtos/order.dto.ts` | Validates create, assign, and list input |
| `src/modules/orders/repositories/order.repository.ts` | Runs tenant-scoped Prisma queries and atomic updates |
| `src/modules/orders/services/order.service.ts` | Applies order rules and optimistic-lock conflict handling |
| `src/modules/orders/controllers/order.controller.ts` | Maps order use cases to HTTP responses |
| `src/modules/orders/order.routes.ts` | Defines authentication, RBAC, validation, and endpoint mapping |
| `src/middlewares/validate.middleware.ts` | Supports body/params/query validation and Express 5 query handling |
| `src/app.ts` | Mounts `/api/v1/orders` |
| `src/docs/openapi.yaml` | Documents order endpoints and payloads |

## 16. Validation commands

The following commands pass after Phase 2:

```bash
npm run prisma:generate
npm run typecheck
npm run build
npm test
npx prisma validate
npx prisma migrate status
```

The current `node --test` command reports zero automated test files. The
keyset and concurrency scenarios above were verified as live local HTTP flows.

## 17. Known limitations and future improvements

Phase 2 establishes the core order boundary but does not yet implement the full
delivery lifecycle.

### Order workflow

- Add a `GET /api/v1/orders/:id` detail endpoint.
- Add controlled transitions for `IN_TRANSIT`, `COMPLETED`, and `CANCELLED`.
- Add a driver-facing route for accepting and progressing assigned jobs.
- Add order event history so status changes are auditable.

### Reference validation

- Verify `customerId` exists and belongs to the tenant.
- Verify `driverId` exists, is active, and is eligible for the tenant.
- Add a proper customer or billing-profile module.

### Pagination and performance

- Use a composite cursor such as `(createdAt, id)` for fully deterministic
  ordering when timestamps collide.
- Add query-plan checks with representative production-sized data.
- Add response metadata such as total counts only when the product requires it;
  counting every page can be expensive at high volume.

### Reliability and testing

- Add automated repository integration tests against a test PostgreSQL database.
- Add service unit tests with a fake repository.
- Add role-matrix tests for every order endpoint.
- Add load tests that issue many competing assignments.
- Add structured audit logs for assignment conflicts.

## 18. Phase 2 outcome

The project now has a tenant-aware order management foundation with:

```text
validated request
  → authenticated dispatcher
  → tenant-scoped repository query
  → atomic version-checked update
  → clear 200 or 409 response
```

This is the foundation required before adding driver execution, tracking,
notifications, billing, and other logistics workflows in later phases.
