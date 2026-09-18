# Phase 3 — High-Velocity Telemetry and Real-Time Tracking

## 1. Phase purpose

Phase 3 adds live driver-location tracking to the logistics platform. GPS
devices can produce a location update every few seconds, so this data should
not be written directly to the PostgreSQL order database on every update.

This phase uses a data-tiering strategy:

```text
Latest location     → Redis      → fast reads and geospatial operations
Historical location → MongoDB    → append-oriented route history
Order and identity   → PostgreSQL → transactional business data
```

The tracking module accepts authenticated Socket.io connections from active
drivers, stores the newest location in Redis, records historical points in
MongoDB, and broadcasts updates to clients watching the same order.

This phase introduces:

- MongoDB 6 in the local Docker environment
- Mongoose schema and indexes for location history
- Redis GEOADD storage for the latest driver position
- Redis hashes for complete latest-location details
- an authenticated Socket.io gateway
- tenant-scoped order tracking rooms
- validated GPS coordinates
- HTTP endpoints for live and historical inspection
- native HTTP server integration for Express and Socket.io

## 2. Learning objectives

By completing this phase, you should understand:

1. Why high-frequency telemetry needs a separate data strategy.
2. The difference between hot data and cold historical data.
3. How Redis geospatial indexes support proximity operations.
4. Why a Redis hash is useful alongside a GEO set.
5. How MongoDB document schemas model append-only location history.
6. How Socket.io authentication middleware protects WebSocket connections.
7. How event rooms broadcast updates to interested clients.
8. Why WebSocket rooms must include tenant identity.
9. How HTTP endpoints can inspect data written through WebSockets.
10. How graceful startup and shutdown must handle three data systems.
11. How to test real-time events with Postman.

## 3. Why PostgreSQL should not receive every GPS ping

PostgreSQL is the system of record for relational business operations such as
users, tenants, and orders. It is excellent for transactions, constraints,
joins, and durable business state.

GPS telemetry has a different access pattern:

- very frequent writes
- mostly append-only history
- many reads asking only for the latest position
- occasional timeline replay queries
- geospatial and proximity operations

If millions of drivers send a ping every five seconds, directly updating the
same relational system can increase connection pressure, WAL volume, index
maintenance, and contention with order-management transactions.

The tiered design separates those workloads:

```text
Driver GPS ping
      │
      ├── Redis GEOADD + latest hash
      │       └── latest position and fast operational reads
      │
      └── MongoDB LocationHistory document
              └── route replay and historical audit data
```

PostgreSQL remains available for the order state and identity data without
being the write target for every location update.

## 4. Architecture

### 4.1 Module structure

```text
src/
├── config/
│   ├── database.ts                 Prisma PostgreSQL client
│   ├── environment.ts              Runtime environment validation
│   └── redis.ts                     Redis client and connection helper
├── modules/
│   ├── auth/
│   ├── orders/
│   └── tracking/
│       ├── models/
│       │   └── locationHistory.model.ts
│       ├── gateways/
│       │   └── tracking.gateway.ts
│       ├── services/
│       │   └── tracking.service.ts
│       └── tracking.routes.ts
├── app.ts                           Express application and routes
└── server.ts                        Native HTTP/WebSocket bootstrap
```

### 4.2 Runtime architecture

```text
                         ┌──────────────────────┐
                         │ Driver Socket.io     │
                         │ connection           │
                         └──────────┬───────────┘
                                    │ driver:ping
                                    ▼
                         ┌──────────────────────┐
                         │ TrackingGateway      │
                         │ JWT + Redis session  │
                         │ event validation     │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ TrackingService      │
                         └───────┬────────┬─────┘
                                 │        │
                       GEOADD + hash     │ create document
                                 │        │
                                 ▼        ▼
                         ┌──────────┐ ┌──────────┐
                         │ Redis    │ │ MongoDB  │
                         │ Hot tier │ │ Cold tier│
                         └────┬─────┘ └────┬─────┘
                              │             │
             GET /tracking/live             │ GET /tracking/history
                              │             │
                              └──────┬──────┘
                                     ▼
                         ┌──────────────────────┐
                         │ Authenticated client │
                         └──────────────────────┘
```

### 4.3 HTTP and Socket.io server relationship

Express alone listens for HTTP requests. Socket.io needs the underlying native
HTTP server so it can perform its handshake and maintain WebSocket connections.

```typescript
const server = http.createServer(app);
new TrackingGateway(server);
server.listen(PORT);
```

The result is one port with two protocols:

```text
http://localhost:5001/api/v1/tracking/live/:driverId
http://localhost:5001/socket.io/...
```

The Socket.io client connects to `http://localhost:5001`, not to an ordinary
Express route such as `/api/v1/tracking`.

## 5. MongoDB history model

The Mongoose model lives in
`src/modules/tracking/models/locationHistory.model.ts`.

```typescript
const LocationHistorySchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    driverId: { type: String, required: true, index: true },
    orderId: { type: String, required: true, index: true },
    coordinates: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);
```

Each GPS point becomes one document. A document is intentionally simple so
that historical route reads can stream records in timestamp order.

### 5.1 Field descriptions

| Field | Description |
| --- | --- |
| `tenantId` | Organization partition key |
| `driverId` | Driver identity that emitted the point |
| `orderId` | Order or delivery job being tracked |
| `coordinates.lat` | Latitude from -90 to 90 |
| `coordinates.lng` | Longitude from -180 to 180 |
| `timestamp` | Time at which the server recorded the point |

### 5.2 Mongo indexes

The model defines indexes for common queries:

```typescript
LocationHistorySchema.index({ orderId: 1, timestamp: 1 });
LocationHistorySchema.index({ tenantId: 1, orderId: 1, timestamp: 1 });
```

The compound tenant/order/timestamp index supports the historical route query:

```text
find history for tenant X and order Y, sorted oldest to newest
```

`versionKey: false` removes MongoDB's default `__v` field because the document
is an append-only telemetry point and does not use Mongoose document versioning.

## 6. Redis hot tier

### 6.1 Geospatial key

For each tenant, the service maintains a Redis GEO set:

```text
tracking:live:<tenantId>
```

Each member is a driver ID. The member's longitude and latitude are written by
`GEOADD`:

```typescript
await redisClient.geoAdd(`tracking:live:${tenantId}`, {
  longitude: lng,
  latitude: lat,
  member: driverId,
});
```

Redis can later use this set for operations such as finding drivers within a
radius. The current Phase 3 HTTP surface focuses on reading a known driver's
latest point; a nearby-driver endpoint is a future extension.

### 6.2 Latest-location hash

The complete latest payload is stored in a tenant-scoped hash:

```text
tracking:latest:<tenantId>:<driverId>
```

Example fields:

```text
tenantId  → tenant UUID
orderId   → order UUID
lat       → "12.975"
lng       → "77.6"
timestamp → "178962...
```

The GEO set is optimized for spatial operations. The hash is optimized for
retrieving the full latest event in one read.

### 6.3 Tenant isolation

Tenant IDs are part of both Redis key patterns. This prevents a request from
tenant A from reading the latest location stored under tenant B, even if a
driver ID happens to be known.

## 7. Tracking service

`src/modules/tracking/services/tracking.service.ts` is the data-tiering layer.

### 7.1 Processing a driver ping

```text
1. Capture one server timestamp.
2. GEOADD the driver's latest coordinates into Redis.
3. HSET the complete latest-location payload in Redis.
4. Create one LocationHistory document in MongoDB.
```

The hot Redis writes happen before the MongoDB history write. PostgreSQL is not
part of the ping path.

### 7.2 Reading a live location

The service reads one tenant-scoped Redis hash and converts string values back
to numbers and a JavaScript `Date`:

```typescript
return {
  tenantId,
  orderId: data.orderId,
  lat: Number.parseFloat(data.lat),
  lng: Number.parseFloat(data.lng),
  timestamp: new Date(Number.parseInt(data.timestamp, 10)),
};
```

If no complete latest hash exists, the service returns `null` and the route
responds with HTTP 404.

### 7.3 Reading historical route data

History is queried with both `tenantId` and `orderId`, then sorted in ascending
timestamp order:

```typescript
return LocationHistory.find({ tenantId, orderId })
  .sort({ timestamp: 1 })
  .lean();
```

`.lean()` returns plain JavaScript objects instead of full Mongoose documents,
which is efficient for read-only API responses.

### 7.4 Current cold-write strategy

The current implementation writes each history point directly with
`LocationHistory.create`. This keeps the learning implementation simple and
makes a point available for inspection immediately.

At high production volume, the next improvement is an asynchronous buffer:

```text
Socket event
   ├── await Redis hot write
   └── enqueue history point
          └── worker insertMany(batch)
```

That worker can flush by size or time interval, retry failed batches, and send
dead-letter records to an operational queue.

## 8. Socket.io gateway

The gateway lives in `src/modules/tracking/gateways/tracking.gateway.ts`.

### 8.1 Authentication handshake

The gateway accepts a token from either:

```text
socket.handshake.auth.token
socket.handshake.query.token
```

It then:

1. Verifies the JWT signature.
2. Validates `userId`, `tenantId`, `email`, and role claims.
3. Checks the matching Redis session key.
4. Stores the verified user in `socket.data.user`.

This mirrors the HTTP authentication model. A valid JWT that has been logged
out is rejected because its Redis session no longer exists.

### 8.2 Order rooms

Clients emit:

```text
join:order_track
```

with a UUID order ID. The gateway joins the tenant-scoped room:

```text
room:order:<tenantId>:<orderId>
```

Including the tenant in the room name prevents identical order IDs from
different organizations from sharing a broadcast channel.

### 8.3 Driver ping event

Drivers emit:

```text
driver:ping
```

with:

```json
{
  "orderId": "6a03b64c-39c6-4f5a-80d5-664bf3a5215e",
  "lat": 12.9716,
  "lng": 77.5946
}
```

The event is accepted only for a JWT with the `DRIVER` role. Coordinates are
validated before they reach Redis or MongoDB:

- latitude: -90 through 90
- longitude: -180 through 180
- order ID: valid UUID

Invalid payloads are ignored by the current event handler. A future version can
use Socket.io acknowledgements to return structured validation errors.

### 8.4 Broadcast event

After the hot and cold writes succeed, the gateway emits:

```text
tracking:update
```

to the tenant/order room:

```json
{
  "driverId": "driver-uuid",
  "orderId": "order-uuid",
  "coordinates": {
    "lat": 12.9716,
    "lng": 77.5946
  },
  "timestamp": "2026-09-18T10:00:00.000Z"
}
```

If persistence fails, the originating socket receives:

```text
tracking:error
```

with a safe message rather than a database error.

## 9. HTTP inspection routes

The routes are mounted at `/api/v1/tracking`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/tracking/live/:driverId` | Read the latest Redis location |
| `GET` | `/api/v1/tracking/history/:orderId` | Read MongoDB route history |

Both routes use the existing JWT middleware. The service derives `tenantId`
from the verified request rather than accepting it from the URL or body.

### Live location request

```bash
curl -i \
  http://localhost:5001/api/v1/tracking/live/<driver-id> \
  -H 'Authorization: Bearer <access-token>'
```

Successful response:

```json
{
  "success": true,
  "data": {
    "tenantId": "tenant-uuid",
    "orderId": "order-uuid",
    "lat": 12.975,
    "lng": 77.6,
    "timestamp": "2026-09-18T10:00:00.000Z"
  }
}
```

### History request

```bash
curl -i \
  http://localhost:5001/api/v1/tracking/history/<order-id> \
  -H 'Authorization: Bearer <access-token>'
```

Successful response:

```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "tenantId": "tenant-uuid",
      "driverId": "driver-uuid",
      "orderId": "order-uuid",
      "coordinates": {
        "lat": 12.9716,
        "lng": 77.5946
      },
      "timestamp": "2026-09-18T09:59:00.000Z"
    }
  ]
}
```

## 10. Local infrastructure

### 10.1 Docker services

`docker-compose.yml` now defines:

| Service | Port | Purpose |
| --- | --- | --- |
| PostgreSQL | `5432` | Auth and order transactions |
| Redis | `6379` | Sessions and live location hot tier |
| MongoDB | `27017` | Historical telemetry cold tier |

MongoDB uses a named volume named `mongo_data` so local data survives a normal
container restart.

### 10.2 Environment configuration

The local `.env` contains:

```ini
MONGODB_URI=mongodb://root:SecretMongoPass123@localhost:27017/enterprise_tracking?authSource=admin
```

The same setting is documented in `.env.example`. Real credentials must not be
committed to source control.

### 10.3 Start the services

```bash
docker compose up -d
docker compose ps
```

Wait until MongoDB reports that it is listening before starting the API. Mongo
initialization can take longer than PostgreSQL and Redis on the first run.

### 10.4 Start the API

```bash
npm run dev
```

Expected startup messages include:

```text
Secure In-Memory Redis Engine Connected.
PostgreSQL transactional storage connected.
MongoDB tracking history connected.
Socket.io telemetry gateway mounted.
Logistics API listening on http://localhost:5001/health
```

## 11. Postman Socket.io verification

### 11.1 Connect

Create a new **Socket.IO** request in Postman. Do not create a normal HTTP GET
request and do not use the Express `/api/v1/tracking` path.

Use:

```text
http://localhost:5001?token=<access-token>
```

The gateway supports the token query parameter for local testing. In a client
application, prefer the Socket.io auth object where possible.

### 11.2 Listen for updates

In the Postman **Events** tab, add:

```text
tracking:update
tracking:error
```

These are listeners. They are not the events that the driver sends.

### 11.3 Join an order room

In the **Message** tab, enter the event name:

```text
join:order_track
```

Use the order ID as a JSON string payload:

```json
"YOUR_ORDER_ID"
```

Click **Send**.

### 11.4 Send a driver ping

Change the message event name to:

```text
driver:ping
```

Use a JSON payload:

```json
{
  "orderId": "YOUR_ORDER_ID",
  "lat": 12.9716,
  "lng": 77.5946
}
```

Click **Send**. A `tracking:update` event should appear in the response panel.

The driver token must contain `role: DRIVER`. Admin and organization-manager
tokens can authenticate and inspect data, but the current gateway ignores their
`driver:ping` events.

## 12. Verification results

### 12.1 Service startup

The local server was started with all dependencies available. Observed:

```text
Redis connected
PostgreSQL connected
MongoDB tracking history connected
Socket.io telemetry gateway mounted
Health endpoint: HTTP 200
```

### 12.2 Hot and cold tier flow

Two GPS points were processed for the same tenant, driver, and order:

```text
Point 1: 12.9716, 77.5946
Point 2: 12.9750, 77.6000
```

Observed through the authenticated HTTP routes:

```text
Live location: HTTP 200, latest point = 12.9750, 77.6000
History:       HTTP 200, count = 2
```

This verifies that Redis returned the newest position while MongoDB retained
both historical points.

### 12.3 Build and static checks

The following commands pass:

```bash
npm run typecheck
npm run build
npm test
npx prisma validate
```

The current `node --test` command reports zero automated test files. The
telemetry flow above was verified with live local Redis, MongoDB, PostgreSQL,
HTTP, and Socket.io infrastructure.

## 13. Problems found and fixes

### Problem 1 — Socket.io was tested as normal HTTP

Requesting:

```text
GET http://localhost:5001?token=...
```

returns `Cannot GET /` because Express has no ordinary root route. The correct
Postman request type is Socket.io, which performs the Socket.io handshake.

### Problem 2 — Event name was sent as a message body

Sending this as a generic `message` event does not call the gateway handler:

```text
message: join:order_track
```

The event name must be entered in Postman's event-name field, while the order ID
is the payload.

### Problem 3 — Admin token sent a driver ping

The gateway intentionally checks:

```typescript
if (user.role !== UserRole.DRIVER) return;
```

An admin can connect successfully but cannot act as a driver. Use a local test
user whose role is `DRIVER`, then log in again to obtain a token with the updated
role claim.

### Problem 4 — MongoDB startup race

On first startup, MongoDB may still be initializing while the API attempts its
connection. Start the Compose services first, wait for MongoDB to report that it
is accepting connections, and then start the API.

## 14. File responsibilities

| File | Responsibility |
| --- | --- |
| `src/modules/tracking/models/locationHistory.model.ts` | Defines the MongoDB location-history schema and indexes |
| `src/modules/tracking/services/tracking.service.ts` | Writes hot Redis data and cold MongoDB history; reads live/history data |
| `src/modules/tracking/gateways/tracking.gateway.ts` | Authenticates Socket.io clients, handles events, and broadcasts updates |
| `src/modules/tracking/tracking.routes.ts` | Defines authenticated live and history HTTP endpoints |
| `src/server.ts` | Connects PostgreSQL, Redis, MongoDB, and Socket.io; manages shutdown |
| `src/config/environment.ts` | Validates `MONGODB_URI` and other runtime settings |
| `docker-compose.yml` | Adds the local MongoDB service and persistent volume |
| `src/docs/openapi.yaml` | Documents live and historical tracking endpoints |
| `src/app.ts` | Mounts `/api/v1/tracking` |

## 15. Known limitations and future improvements

### Ingestion and durability

- Replace one-document-per-ping writes with a buffered `insertMany` worker.
- Add retries and a dead-letter path for failed MongoDB batches.
- Add backpressure when a driver sends pings faster than the configured rate.
- Add a retention policy or TTL strategy for historical data where appropriate.

### Geospatial operations

- Add a nearby-driver endpoint using Redis `GEOSEARCH`.
- Add a route-distance and estimated-arrival-time service.
- Remove or expire stale drivers from the live GEO set.

### Security and authorization

- Verify that a driver is assigned to the order before accepting its ping.
- Verify that the requested order belongs to the tenant and exists in PostgreSQL.
- Use Socket.io acknowledgements for validation and authorization errors.
- Avoid query-string tokens in production because URLs can be logged; use the
  Socket.io auth handshake or a short-lived connection token.
- Restrict Socket.io CORS origins instead of allowing `*`.

### Scalability

- Use a shared Socket.io adapter such as Redis when multiple API instances run.
- Move cold persistence to a queue and worker process.
- Add metrics for ping rate, Redis latency, MongoDB latency, dropped events, and
  active socket connections.
- Partition historical storage by tenant and time at larger volumes.

## 16. Phase 3 outcome

The project now has a functioning telemetry foundation:

```text
authenticated driver
  → Socket.io driver:ping
  → validated GPS coordinates
  → Redis latest location + GEO index
  → MongoDB historical point
  → tenant-scoped tracking:update broadcast
```

This provides the real-time location layer needed for dispatcher maps,
customer tracking links, proximity searches, route replay, and future fleet
analytics.
