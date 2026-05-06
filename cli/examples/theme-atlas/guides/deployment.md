# Deployment Guide

How we ship code to production.

## Process

1. Merge PR to `main`
2. CI builds and runs tests
3. Staging deploy happens automatically
4. Verify on staging (smoke test + check monitoring)
5. Promote to production via the deploy dashboard

## Rollback

If something goes wrong:

1. Click "Rollback" on the deploy dashboard
2. This deploys the previous known-good version
3. Post in `#incidents` with a summary
4. Investigate the root cause before re-deploying the fix
