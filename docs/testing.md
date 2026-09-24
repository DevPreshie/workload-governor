# Testing

## API integration tests

API tests run with Jest and Supertest. The API project uses `tests/api/setup.ts`, which replaces PostgreSQL with an in-memory `MockPool`; no database or Soroban testnet account is required.

Run the maintainer authorization suite with:

```bash
npx jest --runInBand --selectProjects api tests/api/maintainer-transactions.test.ts
```

The suite mocks `SorobanService` at the service boundary, seeds `api_keys` with the key hash and maintainer/org identity, and seeds `maintainers` for registered maintainers. API keys may also have a `revoked_at` value; revoked keys must receive `401` before the transaction route is reached.

The maintainer transaction endpoints require all of the following:

- `Authorization: Bearer <api-key>` must identify an active API key.
- The key's `maintainer_address` and `org_id` must match the request body.
- The `(address, org_id)` pair must exist in `maintainers`.

The suite covers these rules for `POST /api/transactions/assign`, `complete`, and `revoke`, including successful authorization, unregistered maintainers, missing keys, organization mismatches, and revoked keys.
