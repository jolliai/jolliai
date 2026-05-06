# Testing Strategy

Our approach to testing software.

## Test Pyramid

- **Unit tests** — fast, isolated, cover business logic (80% of tests)
- **Integration tests** — verify components work together (15% of tests)
- **End-to-end tests** — simulate real user flows (5% of tests)

## What to Test

- Every public function in a module
- Error paths, not just happy paths
- Edge cases: empty input, large input, null/undefined
- Security boundaries: auth checks, input validation

## What NOT to Test

- Private implementation details
- Third-party library behaviour
- Trivial getters/setters
