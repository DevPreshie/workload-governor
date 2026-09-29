# WorkloadGovernor Admin Guide

This guide covers the full operational lifecycle for administrators of the
WorkloadGovernor contract on the Stellar network. Administrators hold the
privileged `admin` address and are the only callers authorised to initialise
the contract, manage maintainers, transfer admin authority, and trigger
contract upgrades.

---

## Table of Contents

1. [Contract Initialisation](#1-contract-initialisation)
2. [Maintainer Onboarding](#2-maintainer-onboarding)
3. [Maintainer Offboarding](#3-maintainer-offboarding)
4. [Two-Step Admin Transfer](#4-two-step-admin-transfer)
5. [Contract Upgrade](#5-contract-upgrade)
6. [Org Assignment Cap Management](#6-org-assignment-cap-management)

---

## 1. Contract Initialisation

### Pre-flight checklist

Before calling `initialize`, confirm the following:

- [ ] The WASM has been deployed and optimised (see [Contract Upgrade Runbook](runbooks/contract-upgrade.md)).
- [ ] The admin keypair is stored securely (hardware wallet or secrets manager).
- [ ] No other party has already called `initialize` on this contract instance.
- [ ] You have the contract ID returned by `stellar contract deploy`.

### Calling `initialize`

[`initialize(admin)`](../docs/api-reference.md#initialize) performs a one-time
setup. It writes the `admin` address to persistent storage under the key
`"admin"` and marks the contract as ready for state-changing calls.

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source <admin-account> \
  -- initialize \
  --admin <ADMIN_ADDRESS>
```

### Verifying on Horizon

After the transaction confirms, verify the admin is set by querying the
contract's ledger data via Horizon:

```bash
curl "https://horizon-testnet.stellar.org/accounts/<CONTRACT_ID>/data/admin"
```

The response `value` field will contain the base64-encoded admin address.

Alternatively, call any read-only function (e.g. `get_global_application_count`)
to confirm the contract responds without a `NotInitialized` error.

### What happens if called twice

If `initialize` is invoked again after the contract is already set up, it
returns error code **1 — `AlreadyInitialized`**. See
[docs/error-reference.md](error-reference.md#1--alreadyinitialized) for full
details. No state is mutated on the second call.

---

## 2. Maintainer Onboarding

Maintainers are addresses authorised to call assignment-management functions
([`assign_issue`](../docs/api-reference.md#assign_issue),
[`complete_assignment`](../docs/api-reference.md#complete_assignment),
[`revoke_assignment`](../docs/api-reference.md#revoke_assignment)) for a
specific organisation.

### Registering a maintainer

[`register_maintainer(admin, maintainer, org_id)`](../docs/api-reference.md#register_maintainer)
writes `true` to the persistent storage key `("maint", maintainer, org_id)`.

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source <admin-account> \
  -- register_maintainer \
  --admin <ADMIN_ADDRESS> \
  --maintainer <MAINTAINER_ADDRESS> \
  --org_id "stellar-org"
```

### Verifying the maintainer entry

Query Horizon directly for the storage key to confirm the entry exists:

```bash
# The key is ("maint", maintainer_address, org_id) encoded as contract data
stellar contract read \
  --id <CONTRACT_ID> \
  --network testnet \
  --key '("maint", "<MAINTAINER_ADDRESS>", "stellar-org")'
```

A returned value of `true` (Soroban `Bool`) confirms the maintainer is
registered.

### Notes

- A maintainer address can be registered for multiple organisations by calling
  `register_maintainer` once per `org_id`.
- There is no maximum number of maintainers per organisation.
- If the caller is not the admin, the call returns error code
  **3 — `UnauthorizedAdmin`**.

---

## 3. Maintainer Offboarding

### Deregistering a maintainer

[`deregister_maintainer(admin, maintainer, org_id)`](../docs/api-reference.md#deregister_maintainer)
removes the `("maint", maintainer, org_id)` persistent storage key, revoking
the maintainer's authorisation for that organisation.

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source <admin-account> \
  -- deregister_maintainer \
  --admin <ADMIN_ADDRESS> \
  --maintainer <MAINTAINER_ADDRESS> \
  --org_id "stellar-org"
```

### Impact on in-flight assignments

Deregistering a maintainer has **no retroactive effect** on assignments they
have already created. In-flight assignments (recorded under
`("asgn", org_id, issue_id, contributor)`) remain active and will count toward
contributor assignment caps until a maintainer with valid credentials calls
[`complete_assignment`](../docs/api-reference.md#complete_assignment) or
[`revoke_assignment`](../docs/api-reference.md#revoke_assignment).

After deregistration, the former maintainer can no longer call any assignment
function for that `org_id`. Attempts will return error code
**4 — `UnauthorizedMaintainer`**. See
[docs/error-reference.md](error-reference.md#4--unauthorizedmaintainer).

**Recommended procedure for clean offboarding:**

1. Have another registered maintainer take over or close any open assignments
   before deregistering the departing maintainer.
2. Deregister only after all in-flight work has been transferred or resolved.

---

## 4. Two-Step Admin Transfer

Admin key rotation uses a secure two-step mechanism to prevent key loss or
hijacking during the handover. The full step-by-step procedure is documented
in [docs/runbooks/admin-key-rotation.md](runbooks/admin-key-rotation.md).

### Why two steps?

A single-step transfer (admin writes new admin atomically) creates a race
window: if the new key is compromised between the time the admin writes it and
the time the new keyholder logs in, an attacker could claim authority. The
two-step model requires both parties to act:

- **Step 1 — [`propose_admin(current_admin, new_admin)`](../docs/api-reference.md#propose_admin)**:
  The current admin nominates the new address. The proposal is stored on-chain
  under the `"p_admin"` persistent key. The current admin retains full
  authority until Step 2 completes.
- **Step 2 — [`accept_admin(new_admin)`](../docs/api-reference.md#accept_admin)**:
  The nominated address signs a transaction to accept the proposal. On
  confirmation, the `"admin"` persistent key is updated atomically and the
  current admin loses all on-chain authority.

### Example walkthrough

```bash
# Step 1 — current admin nominates a new address
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source <current-admin-account> \
  -- propose_admin \
  --current_admin <CURRENT_ADMIN_ADDRESS> \
  --new_admin <NEW_ADMIN_ADDRESS>

# Step 2 — new admin accepts (must be signed by new_admin keypair)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source <new-admin-account> \
  -- accept_admin \
  --new_admin <NEW_ADMIN_ADDRESS>
```

### Error handling

If the address that calls `accept_admin` does not match the address stored in
`"p_admin"`, the contract returns error code **3 — `UnauthorizedAdmin`**. See
[docs/error-reference.md](error-reference.md#3--unauthorizedadmin).

The current admin can overwrite the pending proposal at any time by calling
`propose_admin` again with a corrected `new_admin` address. This is the
recommended recovery path if the wrong address was nominated.

---

## 5. Contract Upgrade

The full upgrade procedure, including WASM optimisation, upload, and the
`upgrade` call, is documented in
[docs/runbooks/contract-upgrade.md](runbooks/contract-upgrade.md).

### Prerequisite: WASM optimisation

Before uploading a new WASM binary to mainnet, it **must** be optimised to
meet the 64 KB contract size limit:

```bash
stellar contract optimize \
  --wasm target/wasm32v1-none/release/workload_governor.wasm
```

The release profile in `Cargo.toml` already sets `opt-level = 'z'` and
`lto = true` to minimise binary size before optimisation.

### Calling `upgrade`

[`upgrade(new_wasm_hash)`](../docs/api-reference.md#upgrade) replaces the
contract's on-chain WASM with the uploaded binary identified by
`new_wasm_hash`. The call is gated to the admin address.

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network mainnet \
  --source <admin-account> \
  -- upgrade \
  --new_wasm_hash <WASM_HASH>
```

### Semver policy

- **Patch versions** (e.g. 0.3.1): storage-compatible; no migration required.
- **Minor versions** (e.g. 0.4.0): may add new storage keys; existing keys are
  unaffected.
- **Major versions** (e.g. 1.0.0): may rename or restructure keys; a migration
  function is provided and documented in the release notes.

Refer to [CHANGELOG.md](../CHANGELOG.md) for the storage change log of each
release.

---

## 6. Org Assignment Cap Management

Each organisation can have a custom assignment cap stored in persistent storage
under the key `("o_cap", org_id)`. This cap overrides the default global limit
of **4 active assignments per contributor per organisation**.

### Default cap value

If no `("o_cap", org_id)` entry exists for an organisation, the contract falls
back to the hard-coded default of **4**. This means new organisations work
correctly without explicit cap configuration.

### Writing the cap

The `("o_cap", org_id)` key is a `u32` value stored in persistent (non-expiring)
storage. To raise or lower the cap for a specific organisation, the admin
upgrades the contract with updated logic, or uses a governance vote followed by
a contract upgrade as described in
[docs/runbooks/cap-emergency-increase.md](runbooks/cap-emergency-increase.md).

### When to raise the cap

Consider raising the org cap when:

- An organisation consistently has more available issues than contributors can
  claim under the default cap.
- Profiling shows that `OrgAssignmentLimitReached` errors (code 7) are
  blocking legitimate contributors. See
  [docs/error-reference.md](error-reference.md#7--orgassignmentlimitreached).
- A governance vote has approved an increase via the process in
  [docs/runbooks/cap-emergency-increase.md](runbooks/cap-emergency-increase.md).

### Monitoring cap utilisation

Use [`get_org_assignment_count(contributor, org_id)`](../docs/api-reference.md#get_org_assignment_count)
to query the current assignment count for any contributor in an organisation,
and compare it against the effective cap.

Use [`get_contributor_snapshot(contributor, org_ids)`](../docs/api-reference.md#get_contributor_snapshot)
to retrieve a combined view of the global application count and per-org
assignment counts atomically (maximum 10 organisations per call; exceeding this
returns error code **12 — `SnapshotOrgLimitExceeded`**).
