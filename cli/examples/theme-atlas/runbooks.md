# Runbooks

Operational procedures for common incidents.

## High Latency Alert

1. Check Grafana dashboard for the affected service
2. Look for recent deployments in the last 2 hours
3. Check database connection pool usage
4. If database is the bottleneck, check slow query log
5. Escalate to the database team if queries are fine but connections are saturated

## 5xx Spike

1. Check error logs for the stack trace
2. Identify if it's a single endpoint or system-wide
3. If single endpoint: check recent PRs that touched that route
4. If system-wide: check infrastructure (database, cache, external APIs)
5. Roll back the most recent deployment if the cause isn't immediately clear
