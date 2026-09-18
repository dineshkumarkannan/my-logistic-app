# Phase 4 — Event-Driven Enterprise Notification Engine

## 1. Phase purpose

Phase 4 adds asynchronous notification processing to the logistics platform.
Order operations should not wait for an email, SMS, or push provider to finish.
Instead, the order service emits an internal event, a listener places durable
jobs on a BullMQ queue, and a background worker processes those jobs separately.

This phase introduces:

- a native Node.js `EventEmitter` event bus
- a BullMQ notification queue backed by Redis
- exponential retry and failure retention policies
- customer and driver notification routing for assigned orders
- an isolated notification worker with mock external delivery latency
- graceful worker and queue shutdown during application termination

## 2. Learning objectives

By completing this phase, you should understand:

1. Why slow third-party integrations should not block an API response.
2. How an in-process event bus decouples the order module from notifications.
3. How BullMQ persists work in Redis until a worker can process it.
4. How job attempts and exponential backoff improve delivery resilience.
5. Why queue producers and workers should have separate responsibilities.
6. How to preserve failures for auditing and operational investigation.
7. How to make event listener initialization and shutdown safe.
8. How to verify asynchronous work independently from the HTTP request.

## 3. Architecture

### 3.1 End-to-end event flow

```text
PATCH /api/v1/orders/:id/assign
              │
              ▼
       OrderController
              │
              ▼
        OrderService
              │
              ├── Atomic PostgreSQL update with optimistic locking
              │
              └── emit("order.status.updated")
                             │
                             ▼
                    Native EventEmitter
                             │
                             ▼
                    Order event listener
                             │
                             ▼
                  BullMQ notification queue
                             │
                             ▼
                             Redis
                             │
                             ▼
                 Notification background worker
                             │
                             ▼
                  Email / SMS / Push adapter
```

The request completes after the order update and event emission. The event
listener starts an asynchronous queue operation and does not make the HTTP
controller wait for the simulated 1.2-second notification delivery.

### 3.2 Module structure

```text
src/
├── config/
│   ├── eventBus.ts                       Shared application event bus
│   └── redis.ts                          Existing Phase 1 Redis client
├── modules/
│   ├── orders/
│   │   └── services/
│   │       └── order.service.ts          Emits order status events
│   └── notifications/
│       ├── jobs/
│       │   └── notification.processor.ts BullMQ background worker
│       ├── listeners/
│       │   └── order.listener.ts          Event-to-job routing
│       ├── services/
│       │   └── notification.queue.ts      BullMQ producer and queue config
│       └── index.ts                       Subsystem bootstrap and shutdown
└── server.ts                             Starts the notification subsystem
```

### 3.3 Responsibility boundaries

| Component | Simple responsibility |
| --- | --- |
| `OrderService` | Updates the order and publishes a domain event after success |
| `globalEventBus` | Transfers an internal event without importing notification code |
| `order.listener.ts` | Converts one order event into one or more notification jobs |
| `notification.queue.ts` | Defines the BullMQ queue and adds jobs |
| `notification.processor.ts` | Consumes jobs and calls the delivery adapter |
| `index.ts` | Starts and stops the listener and worker together |
| Redis | Stores pending, active, delayed, completed, and failed job state |

## 4. Event bus design

The event bus is a small shared module:

```typescript
export interface OrderStatusUpdatedEvent {
  tenantId: string;
  orderId: string;
  status: string;
  driverId?: string;
  customerId: string;
}

export const globalEventBus = new EventEmitter();
```

The order module knows only the event name and payload contract. It does not
import the notifications directory. This is important because notification
processing can later move into a separate service or process without changing
the order workflow.

The event is emitted only after the optimistic-lock update returns a successful
record. A failed assignment therefore cannot generate a false notification.

## 5. BullMQ queue producer

The queue is named `enterprise_notifications` and uses the existing Redis
service. Each job has this payload:

```typescript
interface NotificationJobData {
  recipientId: string;
  title: string;
  body: string;
  channel: "EMAIL" | "SMS" | "PUSH";
}
```

Default reliability behavior:

| Setting | Behavior |
| --- | --- |
| `attempts: 3` | A failed job gets up to three total attempts |
| `backoff: exponential` | Retry delays grow from 5 seconds to 10 and 20 seconds |
| `removeOnComplete: true` | Successful jobs do not permanently grow Redis |
| `removeOnFail: false` | Failed jobs remain available for auditing |

BullMQ uses the `ioredis` adapter for this connection style. That is why both
`bullmq` and `ioredis` are installed in `package.json`; the project's existing
`redis` package remains responsible for the Phase 1/3 application Redis client.

## 6. Event listener workflow

When an order changes to `ASSIGNED`, the listener creates two jobs:

```text
order.status.updated
        │
        ├── send_customer_alert  → EMAIL
        │
        └── send_driver_dispatch → PUSH
```

For other order status changes, the customer alert is still created, while the
driver dispatch alert is created only when a driver is present and the status
is `ASSIGNED`.

The listener uses a fire-and-forget promise with an explicit error handler:

```typescript
void enqueueOrderNotifications(payload).catch((error) => {
  console.error("Notification enqueue failed", error);
});
```

This keeps queue failures visible in logs without turning an already-successful
order update into a failed HTTP response. The listener also guards against
duplicate registration and exposes cleanup for graceful shutdown.

## 7. Background worker

The worker consumes `enterprise_notifications` jobs with concurrency five. The
current local implementation simulates a third-party provider by waiting 1.2
seconds and failing randomly 10% of the time. This makes retry behavior
observable without calling SendGrid, Twilio, or FCM.

```text
Worker receives job
        │
        ▼
Mock provider delay: 1.2 seconds
        │
   ┌────┴────┐
   │         │
success   timeout
   │         │
complete   BullMQ retry with exponential backoff
             │
             └── retained as failed after final attempt
```

The provider simulation is the replacement point for real adapters. A future
implementation can inject channel-specific clients without changing the queue
or event listener contracts.

## 8. Application lifecycle

The server starts the notification subsystem after Redis, PostgreSQL, MongoDB,
and the Socket.io gateway are initialized:

```typescript
bootstrapNotificationsModule();
```

During shutdown, the application:

1. Removes the order event listener.
2. Waits for the notification worker to close.
3. Closes the BullMQ queue connection.
4. Closes the existing Redis, MongoDB, Prisma, and HTTP resources.

This prevents new jobs from being accepted while the process is stopping and
avoids leaving active worker connections behind.

## 9. Local setup

Start the existing infrastructure first:

```bash
docker compose up -d
```

The Phase 4 queue uses the existing `REDIS_URL` value:

```ini
REDIS_URL="redis://localhost:6379"
```

Install dependencies and run the API:

```bash
npm install
npm run dev
```

Expected startup output includes:

```text
Secure In-Memory Redis Engine Connected.
PostgreSQL transactional storage connected.
MongoDB tracking history connected.
Socket.io telemetry gateway mounted.
Event-driven notification queue and worker online.
```

## 10. Verification procedure

### 10.1 Static verification

Run:

```bash
npm run typecheck
npm run build
npm test
git diff --check
```

The project currently has no automated test files, so `npm test` reports zero
tests while still completing successfully.

### 10.2 Queue smoke test

An event can be emitted locally to verify the complete queue and worker path:

```text
Notification subsystem intercepted state change for order order-phase4.
Queued 2 notification task(s) for order order-phase4.
[WORKER] Processing send_customer_alert ... via EMAIL.
[WORKER] Processing send_driver_dispatch ... via PUSH.
[WORKER] Notification delivered to customer-phase4 via EMAIL.
[WORKER] Notification delivered to driver-phase4 via PUSH.
Phase 4 queue verification completed jobs: 2
```

This confirms that one `ASSIGNED` event creates both expected jobs and that the
worker processes them through Redis without blocking the event publisher.

### 10.3 HTTP verification

Use an authenticated dispatcher token and an order currently in `PENDING`:

```http
PATCH http://localhost:5001/api/v1/orders/ORDER_ID/assign
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json
```

```json
{
  "driverId": "DRIVER_UUID",
  "currentVersion": 1
}
```

Expected behavior:

1. The API returns the assigned order and version `2`.
2. The terminal immediately logs the intercepted event.
3. Two notification jobs appear in the worker logs.
4. Delivery logs appear about 1.2 seconds later.
5. A temporary simulated failure is retried automatically by BullMQ.

The API response is not delayed by the simulated provider wait. The exact
latency depends on local database and Redis conditions, but the notification
delivery delay is outside the HTTP request's awaited path.

## 11. Failure handling

| Failure | Result |
| --- | --- |
| Optimistic-lock conflict | Order request returns `409`; no event is emitted |
| Invalid order state | Order request returns `400`; no notification job is created |
| Queue enqueue failure | Order remains successful; enqueue error is logged |
| Temporary provider timeout | BullMQ retries with exponential backoff |
| Final job failure | Job remains in Redis for auditing |
| Process shutdown | Listener and worker close before shared resources |

The current event bus is in-process. If the process crashes between the
database commit and the queue insertion, the notification may not be created.
For stronger delivery guarantees, a future phase can add a transactional
outbox table or publish events through a durable broker.

## 12. Problems encountered and fixes

### Problem 1 — Queue API and worker API need different responsibilities

Putting provider logic in the order service would make the order workflow slow
and tightly coupled to notification vendors.

**Fix:** The order service emits a small event, while the listener and worker
own notification-specific behavior.

### Problem 2 — BullMQ URL connections require `ioredis`

The existing application uses the `redis` package, but BullMQ's URL-based
connection implementation loads `ioredis`.

**Fix:** Install both `bullmq` and `ioredis`. They can use the same Redis server
while remaining separate client connections.

### Problem 3 — Async EventEmitter listeners do not propagate promises

Node's `EventEmitter.emit()` does not await an async listener. A rejected queue
operation could otherwise become an unhandled rejection.

**Fix:** Start the async operation explicitly with `void` and attach a catch
handler that logs the order ID and failure.

### Problem 4 — Workers must be closed during shutdown

BullMQ workers maintain blocking Redis connections. Leaving them open can keep
the process alive or cause duplicate consumers during restarts.

**Fix:** The notifications bootstrap module owns both worker startup and
shutdown, and the server invokes that cleanup before closing Redis.

## 13. Files changed

| File | Responsibility |
| --- | --- |
| `src/config/eventBus.ts` | Defines the shared event bus and event payload |
| `src/modules/notifications/services/notification.queue.ts` | Defines the BullMQ queue, job data, retries, and producer |
| `src/modules/notifications/listeners/order.listener.ts` | Routes order events into notification jobs |
| `src/modules/notifications/jobs/notification.processor.ts` | Processes jobs and simulates provider delivery |
| `src/modules/notifications/index.ts` | Bootstraps and shuts down the subsystem |
| `src/modules/orders/services/order.service.ts` | Emits the successful assignment event |
| `src/server.ts` | Starts and closes the notification subsystem |
| `package.json` | Adds `bullmq` and `ioredis` |

## 14. Future improvements

- Add a transactional outbox for guaranteed event publication.
- Add idempotency keys to prevent duplicate customer notifications.
- Add dead-letter queue handling and an operator retry endpoint.
- Replace the provider simulation with SendGrid, Twilio, and FCM adapters.
- Add queue metrics, trace IDs, structured logs, and alerting.
- Move the worker into a separately deployable process.
- Add automated unit and integration tests for enqueueing and retries.
- Encrypt or minimize notification payloads containing sensitive customer data.

## 15. Phase 4 outcome

The logistics API now separates operational state changes from slow notification
delivery:

```text
Order assignment
      │
      ▼
PostgreSQL state update
      │
      ▼
Internal event
      │
      ▼
Redis-backed BullMQ jobs
      │
      ▼
Independent retryable worker
```

This provides a practical foundation for fault-tolerant, high-volume
notifications while keeping the order API responsive and the module boundary
ready for a future microservice split.
