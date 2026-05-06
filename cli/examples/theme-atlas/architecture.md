# Architecture

High-level overview of our system architecture.

## Services

| Service | Language | Purpose |
|---------|----------|---------|
| API Gateway | TypeScript | Request routing, auth, rate limiting |
| Core Service | TypeScript | Business logic, data processing |
| Worker | Go | Background jobs, heavy computation |
| Frontend | React | Web application |

## Data Flow

1. Client sends request to API Gateway
2. Gateway authenticates and routes to Core Service
3. Core Service processes synchronously or enqueues to Worker
4. Worker processes asynchronously, writes results to database
5. Client polls or receives webhook notification
