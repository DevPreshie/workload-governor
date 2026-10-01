# Error Reference

Complete reference for all WorkloadGovernor error codes. Each section includes
the exact trigger condition, at least one example scenario, resolution steps,
and any storage state side effects.

Cross-references: [docs/api-reference.md](api-reference.md) |
[docs/storage-design.md](storage-design.md)

---

## 1 — `AlreadyInitialized`

**Functions that can raise it:** [`initialize`](api-reference.md#initialize)

### Trigger condition

The contract's persistent `"admin"` key already exists when `initialize` is
called a second time.

### Example scenario

1. Operator deploys a contract and calls `initialize --admin GADMIN1`.
   The `"admin"` key is written to persistent storage.
2. Same operator (or another party) calls `initialize --admin GADMIN2` on the
   same contract ID.
3. The contract checks for the existence of `"admin"`, finds it, and returns
   error code **1**.

### Resolution

Do not call `initialize` more than once per contract instance. If you need to
change the admin address, use the two-step
[`propose_admin`](api-reference.md#propose_admin) /
[`accept_admin`](api-reference.md#accept_admin) flow.

### Storage state after error

No state is mutated. The existing `"admin"` entry is unchanged.

---

## 2 — `NotInitialized`

**Functions that can raise it:** Any state-changing function (e.g.
[`register_maintainer`](api-reference.md#register_maintainer),
[`apply_for_issue`](api-reference.md#apply_for_issue),
[`assign_issue`](api-reference.md#assign_issue), and all others except
`initialize` itself).

### Trigger condition

The persistent `"admin"` key does not exist when a state-changing function is
called. This means `initialize` was never successfully executed.

### Example scenario

1. A developer deploys the WASM but forgets to call `initialize`.
2. A contributor calls `apply_for_issue`. The contract checks for `"admin"`,
   finds nothing, and returns error code **2**.

### Resolution

Call [`initialize`](api-reference.md#initialize) before invoking any other
function. Verify the contract is initialized by querying `"admin"` in Horizon
ledger data or by calling a read-only function and confirming no error is
returned.

### Storage state after error

No state is mutated.

---

## 3 — `UnauthorizedAdmin`

**Functions that can raise it:**
[`register_maintainer`](api-reference.md#register_maintainer),
[`deregister_maintainer`](api-reference.md#deregister_maintainer),
[`upgrade`](api-reference.md#upgrade),
[`propose_admin`](api-reference.md#propose_admin),
[`accept_admin`](api-reference.md#accept_admin)

### Trigger condition

Two separate sub-cases:

- On `propose_admin` and all other admin functions: the signing address does
  not match the on-chain `"admin"` value.
- On `accept_admin`: the signing address does not match the `"p_admin"` pending
  admin value stored by `propose_admin`.

### Example scenario

**Sub-case A — wrong admin key:**
1. Admin calls `register_maintainer` but accidentally signs with the old
   keypair after a key rotation. The on-chain `"admin"` now points to the new
   address.
2. The contract compares the signer to `"admin"`, finds a mismatch, and returns
   error code **3**.

**Sub-case B — accept_admin mismatch:**
1. Admin calls `propose_admin --new_admin GNEW1`, storing `"p_admin" = GNEW1`.
2. Address `GNEW2` (not `GNEW1`) calls `accept_admin`.
3. The contract compares the caller to `"p_admin"`, finds a mismatch, and
   returns error code **3**.

### Resolution

- Confirm the signing keypair matches the current on-chain `"admin"`.
- For `accept_admin`, only the address nominated in `propose_admin` may call it.
  If the wrong address was nominated, the current admin can call `propose_admin`
  again with the correct address.
- See [docs/runbooks/admin-key-rotation.md](runbooks/admin-key-rotation.md) for
  the full key rotation procedure.

### Storage state after error

No state is mutated.

---

## 4 — `UnauthorizedMaintainer`

**Functions that can raise it:**
[`assign_issue`](api-reference.md#assign_issue),
[`complete_assignment`](api-reference.md#complete_assignment),
[`revoke_assignment`](api-reference.md#revoke_assignment)

### Trigger condition

The calling address does not have an entry `("maint", caller, org_id) = true`
in persistent storage for the requested `org_id`.

### Example scenario

1. A maintainer is registered for `"stellar-org"` but not for `"meridian-dao"`.
2. They call `assign_issue --org_id "meridian-dao"`.
3. The contract looks up `("maint", maintainer, "meridian-dao")`, finds no
   entry, and returns error code **4**.

### Resolution

Have an admin call
[`register_maintainer`](api-reference.md#register_maintainer) for the relevant
`org_id` before the maintainer attempts any assignment operation.

### Storage state after error

No state is mutated.

---

## 5 — `UnauthorizedContributor`

**Functions that can raise it:**
[`apply_for_issue`](api-reference.md#apply_for_issue),
[`withdraw_application`](api-reference.md#withdraw_application)

### Trigger condition

The Soroban authentication check fails — the transaction was not signed by the
`contributor` address passed as the function argument.

### Example scenario

1. A backend service calls `apply_for_issue` with `contributor = GCONTRIB1` but
   signs the transaction with a different keypair.
2. Soroban's `require_auth` call for `GCONTRIB1` fails, and the contract returns
   error code **5**.

### Resolution

Ensure the transaction is signed with the keypair that owns the `contributor`
address. Contributors must self-authorise; a third party cannot apply on their
behalf.

### Storage state after error

No state is mutated.

---

## 6 — `GlobalApplicationLimitReached`

**Functions that can raise it:**
[`apply_for_issue`](api-reference.md#apply_for_issue)

### Trigger condition

The temporary storage key `("g_apps", contributor)` already holds the value
**15** (the global pending application cap) when `apply_for_issue` is called.

### Example scenario

1. A contributor applies for 15 different issues across multiple organisations.
   Each call increments `("g_apps", contributor)`.
2. They call `apply_for_issue` for a 16th issue.
3. The contract reads `("g_apps", contributor) = 15`, compares to the cap, and
   returns error code **6**.

### Resolution

The contributor must reduce their pending application count below 15 by:

- Calling [`withdraw_application`](api-reference.md#withdraw_application) to
  cancel one or more pending applications.
- Waiting for a maintainer to call
  [`assign_issue`](api-reference.md#assign_issue) (which converts a pending
  application to an active assignment and decrements the global app count), or
  for the application's TTL to expire on the Stellar ledger (which removes the
  temporary entry and decrements the count automatically).

### Storage state after error

No state is mutated. `("g_apps", contributor)` remains at 15.

---

## 7 — `OrgAssignmentLimitReached`

**Functions that can raise it:**
[`assign_issue`](api-reference.md#assign_issue)

### Trigger condition

The persistent storage key `("o_asgn", contributor, org_id)` is at or above
the effective cap for the organisation when `assign_issue` is called. The
default cap is **4**; organisations may have a custom cap stored at
`("o_cap", org_id)`.

### Example scenario

1. A contributor has been assigned 4 issues in `"stellar-org"`.
2. A maintainer calls `assign_issue` to assign a 5th issue in `"stellar-org"`.
3. The contract reads `("o_asgn", contributor, "stellar-org") = 4`, compares to
   the cap (4), and returns error code **7**.

### Resolution

- The contributor must have an existing assignment completed or revoked before
  a new one can be assigned within the same organisation.
- If the cap is too low for operational needs, an admin can initiate a cap
  increase via the governance process in
  [docs/runbooks/cap-emergency-increase.md](runbooks/cap-emergency-increase.md).

### Storage state after error

No state is mutated. `("o_asgn", contributor, org_id)` remains unchanged.

---

## 8 — `DuplicateApplication`

**Functions that can raise it:**
[`apply_for_issue`](api-reference.md#apply_for_issue)

### Trigger condition

The temporary storage key `("app", contributor, org_id, issue_id)` already
exists when `apply_for_issue` is called with the same `(contributor, org_id,
issue_id)` triple.

### Example scenario

1. A contributor calls `apply_for_issue --org_id "stellar-org" --issue_id 42`.
   The entry `("app", contributor, "stellar-org", 42)` is written to temporary
   storage.
2. The same contributor calls `apply_for_issue` again with the same arguments.
3. The contract finds the existing application entry and returns error code
   **8**.

### Resolution

No action is needed — the original application is still valid. If the
contributor wants to re-apply (e.g. after a TTL bump), they must first call
[`withdraw_application`](api-reference.md#withdraw_application) to remove the
existing entry, then apply again.

### Storage state after error

No state is mutated. The existing application entry is unchanged.

---

## 9 — `ApplicationNotFound`

**Functions that can raise it:**
[`withdraw_application`](api-reference.md#withdraw_application),
[`assign_issue`](api-reference.md#assign_issue)

### Trigger condition

The temporary storage key `("app", contributor, org_id, issue_id)` does not
exist when the function is called.

### Example scenario

**Withdraw on expired application:**
1. A contributor applied for an issue, but the application's temporary TTL
   expired before they withdrew it. The ledger archived the entry.
2. They call `withdraw_application` for that issue.
3. The contract looks for `("app", contributor, org_id, issue_id)`, finds
   nothing, and returns error code **9**.

**Assign without prior application:**
1. A maintainer calls `assign_issue` for a contributor who never applied for
   that issue.
2. Same lookup failure, same error code **9**.

### Resolution

- For `withdraw_application`: the application no longer exists; no action is
  required. The global application counter will have already been decremented
  when the TTL expired.
- For `assign_issue`: confirm the contributor has an active pending application
  by calling [`has_applied`](api-reference.md#has_applied) before assigning.

### Storage state after error

No state is mutated.

---

## 10 — `AssignmentNotFound`

**Functions that can raise it:**
[`complete_assignment`](api-reference.md#complete_assignment),
[`revoke_assignment`](api-reference.md#revoke_assignment)

### Trigger condition

The persistent storage key `("asgn", org_id, issue_id, contributor)` does not
exist when the function is called.

### Example scenario

1. A maintainer calls `complete_assignment` for a contributor on an issue that
   was never formally assigned (or was already completed/revoked).
2. The contract looks for `("asgn", org_id, issue_id, contributor)`, finds
   nothing, and returns error code **10**.

### Resolution

Verify the assignment exists by calling
[`is_assigned`](api-reference.md#is_assigned) before attempting to complete or
revoke. Use [`get_org_assignment_count`](api-reference.md#get_org_assignment_count)
to cross-reference active assignment counts.

### Storage state after error

No state is mutated.

---

## 11 — `AlreadyAssigned`

**Functions that can raise it:**
[`assign_issue`](api-reference.md#assign_issue)

### Trigger condition

The persistent storage key `("asgn", org_id, issue_id, contributor)` already
exists with value `true` when `assign_issue` is called for the same
`(contributor, org_id, issue_id)` triple.

### Example scenario

1. A maintainer calls `assign_issue` for contributor `GCONTRIB1`, `org_id
   "stellar-org"`, `issue_id 99`. The entry is written.
2. A second maintainer (or the same one) calls `assign_issue` again with
   identical arguments.
3. The contract finds the existing assignment and returns error code **11**.

### Resolution

An issue can only be actively assigned once at a time. If a re-assignment is
needed (e.g. the original contributor dropped out), the existing assignment
must first be revoked via
[`revoke_assignment`](api-reference.md#revoke_assignment), after which the
issue can be assigned to the same or a different contributor.

### Storage state after error

No state is mutated.

---

## 12 — `SnapshotOrgLimitExceeded`

**Functions that can raise it:**
[`get_contributor_snapshot`](api-reference.md#get_contributor_snapshot)

### Trigger condition

The `org_ids` vector passed to `get_contributor_snapshot` contains more than
**10** entries.

### Example scenario

1. A frontend client calls `get_contributor_snapshot` with a list of 11
   organisation IDs to build a dashboard.
2. The contract checks the length of `org_ids`, finds it exceeds 10, and
   returns error code **12**.

### Resolution

Split the request into batches of at most 10 organisations. The global
application count returned in each batch will be identical (it is per-contributor,
not per-org), so results can be merged client-side.

### Storage state after error

No state is mutated. This is a validation error that fires before any storage
reads.
