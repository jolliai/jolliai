# Incident Response

How we handle production incidents.

## Severity Levels

| Level | Criteria | Response Time |
|-------|----------|---------------|
| SEV-1 | Service down, data loss risk | 15 minutes |
| SEV-2 | Major feature broken, workaround exists | 1 hour |
| SEV-3 | Minor issue, low user impact | Next business day |

## On-Call Expectations

- Acknowledge pages within 5 minutes
- Start investigating within 15 minutes
- Post status updates every 30 minutes during SEV-1/2
- Write a post-mortem within 48 hours for SEV-1/2

## Post-Mortem Template

1. **Summary** — what happened, impact, duration
2. **Timeline** — key events with timestamps
3. **Root cause** — why it happened
4. **Action items** — what we'll do to prevent recurrence
