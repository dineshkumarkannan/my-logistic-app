# RFC: Monolith Micro-Evolution Strategy and Extraction Blueprint

- **Status:** Proposed
- **Owners:** Logistics Platform Team
- **Scope:** Auth, orders, tracking, notifications, platform operations
- **Current deployment:** Modular monolith
- **Target deployment:** Independently deployable domain services

## 1. Summary

The application is intentionally built as a modular monolith first. This gives
the team one deployable unit while keeping business boundaries visible in the
source tree. The next architectural step is not to split every folder into a
service immediately. It is to extract the domains that have different scaling,
availability, and data-storage requirements.

The recommended extraction order is:

1. Move domain events from the in-process event bus to a durable broker.
2. Extract notifications into an independently deployable worker service.
3. Extract high-volume tracking into its own real-time service.
4. Place an API gateway in front of independently routed domain APIs.
5. Extract the order core only after its data and event contracts are stable.

## 2. Current architecture analysis

The current codebase is a modular monolith. The major domains are separated in
the repository and communicate through explicit service boundaries:

```text
                         ┌─────────────────────────┐
                         │       Express API       │
                         │        (one process)    │
                         └───────────┬─────────────┘
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       │                             │                             │
       ▼                             ▼                             ▼
 ┌────────────┐                ┌────────────┐                ┌────────────┐
 │ Auth       │                │ Orders     │                │ Tracking   │
 │ Redis      │                │ PostgreSQL │                │ Redis/Mongo│
 └────────────┘                └─────┬──────┘                └────────────┘
                                      │
                                      ▼
                               In-process event bus
                                      │
                                      ▼
                               Notifications
                               BullMQ + Redis
```

The modules avoid direct database joins across domains. IDs such as
`customerId`, `driverId`, and `orderId` are exchanged as contract values rather
than cross-module ORM relations. This makes future data ownership changes less
disruptive.

## 3. Target architecture

```text
                         ┌──────────────────────┐
                         │  API Gateway / Edge   │
                         │ Auth, rate limits, TLS│
                         └──────────┬───────────┘
                                    │
        ┌───────────────────────────┼────────────────────────────┐
        │                           │                            │
        ▼                           ▼                            ▼
 ┌───────────────┐           ┌───────────────┐            ┌───────────────┐
 │ Order Service │           │ Tracking      │            │ Auth Service  │
 │ PostgreSQL    │           │ Service       │            │ Identity      │
 │ REST/events   │           │ Redis/Mongo   │            │ Redis         │
 └───────┬───────┘           └───────────────┘            └───────────────┘
         │
         │ logistics.order.events
         ▼
 ┌─────────────────────────┐
 │ Durable Event Broker     │
 │ Kafka or RabbitMQ        │
 └────────────┬────────────┘
              │
              ▼
 ┌─────────────────────────┐
 │ Notification Service     │
 │ BullMQ workers + vendors │
 └─────────────────────────┘
```

The gateway owns client-facing concerns. Each service owns its database and
publishes versioned integration events. The broker provides a durable boundary
between the order transaction and asynchronous consumers.

## 4. Design principles

### 4.1 One service owns one data model

An extracted service must be the only writer for its tables or collections.
Other services use APIs, events, or read models instead of direct database
connections. This prevents hidden coupling from recreating the monolith over a
network.

### 4.2 Events are contracts, not implementation details

Events should contain a stable event name, schema version, event ID, tenant ID,
occurred-at timestamp, and causation/correlation IDs:

```json
{
  "eventId": "uuid",
  "eventType": "order.status.updated",
  "schemaVersion": 1,
  "occurredAt": "2026-09-18T10:00:00.000Z",
  "tenantId": "tenant-uuid",
  "correlationId": "request-uuid",
  "causationId": "optional-parent-event-uuid",
  "payload": {
    "orderId": "order-uuid",
    "customerId": "customer-uuid",
    "driverId": "driver-uuid",
    "status": "ASSIGNED"
  }
}
```

### 4.3 At-least-once delivery requires idempotency

Durable brokers and workers normally provide at-least-once delivery. Consumers
must safely process the same event more than once. Notification jobs should use
an idempotency key such as:

```text
{eventId}:{notificationType}:{recipientId}
```

The notification provider adapter or an inbox table must record that key before
confirming a delivery.

### 4.4 Correlation IDs cross every boundary

The HTTP layer creates or accepts `x-correlation-id`. That value must be copied
into job payloads and event headers. A service should include it in structured
logs, metrics exemplars where supported, and outgoing requests.

## 5. Extraction protocol

### Step 1 — Decentralize data transport

**Current state:** `OrderService` emits `order.status.updated` through the
Node.js `EventEmitter`. The listener and worker share the same process.

**Target state:** The order service publishes a versioned event to a durable
broker topic such as `logistics.order.events`.

Recommended migration sequence:

1. Define the event envelope and schema version.
2. Add an outbox table in the order PostgreSQL database.
3. Write the order change and outbox row in one transaction.
4. Run an outbox publisher that retries broker delivery.
5. Run the in-process listener and broker consumer in parallel temporarily.
6. Compare delivery counts and remove the in-process path after confidence.

The outbox avoids the failure window between a committed order update and a
failed network publish.

### Step 2 — Extract the notification service

Create a separate repository and deployment containing:

```text
notification-service/
├── consumers/
│   └── order-events.consumer.ts
├── jobs/
│   └── notification.processor.ts
├── providers/
│   ├── email.provider.ts
│   ├── push.provider.ts
│   └── sms.provider.ts
├── persistence/
│   └── notification-inbox.repository.ts
└── server.ts
```

The new service consumes `logistics.order.events`, performs idempotency checks,
and creates BullMQ jobs. It owns notification delivery state and provider
credentials. The order service no longer imports notification code.

### Step 3 — Extract the tracking service

Tracking has a different workload from transactional orders: high-frequency
GPS writes, WebSocket connections, geospatial reads, and historical route
storage. Move the current tracking gateway and service into a dedicated
deployment with:

- a dedicated Redis namespace or cluster
- MongoDB ownership for location history
- Socket.io scaling through a Redis adapter or a managed WebSocket layer
- tenant and order authorization at the service boundary
- sampling, rate limits, and backpressure for driver pings

The order ID remains a reference contract. Tracking should not query the order
service database directly.

### Step 4 — Introduce the API gateway

Use Kong, Nginx, Envoy, AWS API Gateway, or an equivalent edge layer to route:

| Route | Destination | Edge responsibilities |
| --- | --- | --- |
| `/api/v1/auth/*` | Auth service | TLS, token policies, rate limits |
| `/api/v1/orders/*` | Order service | JWT forwarding, request limits |
| `/api/v1/tracking/*` | Tracking service | WebSocket upgrade, sticky/session policy |
| `/metrics` | Service-local or metrics gateway | Restrict to monitoring network |

The gateway should not contain business logic. It should provide a consistent
external contract while services remain independently deployable.

## 6. Service ownership map

| Domain | Primary data | Scaling characteristic | First extraction signal |
| --- | --- | --- | --- |
| Auth | PostgreSQL/Redis sessions | Moderate request volume, security-sensitive | Independent identity team or SSO needs |
| Orders | PostgreSQL | Transactional consistency and workflow | Order release cadence differs from platform |
| Tracking | Redis/MongoDB | High write and WebSocket volume | Telemetry load affects API latency |
| Notifications | BullMQ/provider state | Retry-heavy asynchronous work | Provider failures or queue depth affect API |

## 7. Reliability and operations

Every extracted service should provide:

- `/health` for process health and `/ready` for dependency readiness
- Prometheus metrics for request latency, error rate, queue depth, and provider outcomes
- structured JSON logs with `service`, `environment`, `version`, and `correlationId`
- graceful shutdown and connection draining
- retry policies with jitter and a dead-letter workflow
- dashboards and alerts based on user impact, not only CPU
- a documented runbook for dependency outages and replay operations

### Suggested alerts

```text
API 5xx rate > 2% for 5 minutes
p95 order assignment latency > agreed SLO
notification queue oldest job age > 2 minutes
notification failed jobs increasing for 10 minutes
Redis/Mongo/PostgreSQL readiness failure
WebSocket disconnect rate above baseline
```

## 8. Security model

- Keep provider secrets in a secret manager, never in images or source control.
- Use service identities and mTLS or signed broker credentials between services.
- Validate tenant ownership at every service boundary.
- Avoid putting addresses, tokens, or unnecessary personal data into events.
- Restrict `/metrics` to an internal monitoring network or authenticated scraper.
- Run containers as non-root users with read-only filesystems where practical.
- Scan dependencies and container images in CI before deployment.

## 9. Deployment strategy

Use the existing multi-stage Dockerfile as the first production baseline. For
service extraction, each service receives its own image and deployment unit.

```text
Source commit
    │
    ▼
CI: typecheck → test → build → image scan
    │
    ▼
Immutable container image
    │
    ▼
Staging: contract and smoke tests
    │
    ▼
Canary production deployment
    │
    ▼
Progressive traffic shift and rollback window
```

Database migrations must run as an explicit deployment step. A service should
remain backward-compatible with the previous event and API schema during a
rolling deployment.

## 10. Migration risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Duplicate events | Event IDs, inbox/outbox records, idempotent consumers |
| Lost events | Transactional outbox and broker acknowledgements |
| Network partitions | Timeouts, bounded retries, circuit breakers |
| Data drift | Contract tests, schema versioning, reconciliation jobs |
| Distributed tracing gaps | Propagate correlation IDs in headers and event envelopes |
| Operational complexity | Start with only tracking and notifications extraction |
| Cross-service latency | Read models, caching, and asynchronous workflows |
| Inconsistent authorization | Shared identity contract and service-level tenant checks |

## 11. Decision record

The team should keep the modular monolith until at least one measurable trigger
is reached:

- tracking traffic materially impacts order API SLOs
- notification queue operations require independent scaling or on-call
- domain teams need independent release cadence
- a domain has clear data ownership and stable integration contracts

Premature extraction would add network failure modes, deployment overhead, and
distributed data consistency problems without solving a current bottleneck.

## 12. Conclusion

The codebase is ready for evolutionary extraction because its domain modules,
tenant boundaries, optimistic locking, hot/cold tracking tiers, asynchronous
notification queue, correlation IDs, metrics, and production container are
already explicit. The next safe step is to make events durable with an outbox
and broker, then extract notifications and tracking according to measurable
operational need.
