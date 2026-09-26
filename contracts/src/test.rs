//! Smoke tests for the `contracts/` re-export shim.
//!
//! These tests verify that the re-exported `WorkloadGovernor` type compiles and
//! behaves identically to the root crate.  Full behavioural coverage lives in
//! `../../src/test.rs`; this file asserts only that the re-export wiring is
//! correct and the canonical interface is reachable from this package.
//!
//! Run with:  cargo test --package contracts --features testutils

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

// The re-exported struct and its generated client from the root crate.
use workload_governor::{WorkloadGovernor, WorkloadGovernorClient};

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

struct Setup<'a> {
    env: &'a Env,
    client: WorkloadGovernorClient<'a>,
}

impl<'a> Setup<'a> {
    fn new(env: &'a Env) -> Self {
        env.mock_all_auths();
        let contract_id = env.register(WorkloadGovernor, ());
        let client = WorkloadGovernorClient::new(env, &contract_id);
        Setup { env, client }
    }

    fn org(&self, name: &str) -> Symbol {
        Symbol::new(self.env, name)
    }
}

// ---------------------------------------------------------------------------
// Smoke tests — re-export wiring
// ---------------------------------------------------------------------------

#[test]
fn contracts_smoke_initialize() {
    let env = Env::default();
    let s = Setup::new(&env);
    let admin = Address::generate(&env);
    s.client.initialize(&admin);
    // Default cap is 15.
    assert_eq!(s.client.get_global_cap(), 15);
}

#[test]
fn contracts_smoke_apply_and_query() {
    let env = Env::default();
    let s = Setup::new(&env);
    let admin = Address::generate(&env);
    let maintainer = Address::generate(&env);
    let contributor = Address::generate(&env);
    let org = s.org("myorg");

    s.client.initialize(&admin);
    s.client.register_maintainer(&admin, &maintainer, &org);
    s.client.apply_for_issue(&contributor, &org, &42u32);

    assert!(s.client.has_applied(&contributor, &org, &42u32));
    assert_eq!(s.client.get_global_application_count(&contributor), 1);
}

#[test]
fn contracts_smoke_withdraw() {
    let env = Env::default();
    let s = Setup::new(&env);
    let admin = Address::generate(&env);
    let maintainer = Address::generate(&env);
    let contributor = Address::generate(&env);
    let org = s.org("myorg");

    s.client.initialize(&admin);
    s.client.register_maintainer(&admin, &maintainer, &org);
    s.client.apply_for_issue(&contributor, &org, &7u32);
    s.client.withdraw_application(&contributor, &org, &7u32);

    assert!(!s.client.has_applied(&contributor, &org, &7u32));
    assert_eq!(s.client.get_global_application_count(&contributor), 0);
}

#[test]
fn contracts_smoke_assign_complete() {
    let env = Env::default();
    let s = Setup::new(&env);
    let admin = Address::generate(&env);
    let maintainer = Address::generate(&env);
    let contributor = Address::generate(&env);
    let org = s.org("myorg");

    s.client.initialize(&admin);
    s.client.register_maintainer(&admin, &maintainer, &org);
    s.client.apply_for_issue(&contributor, &org, &99u32);
    s.client.assign_issue(&maintainer, &contributor, &org, &99u32);

    assert!(s.client.is_assigned(&contributor, &org, &99u32));
    assert_eq!(s.client.get_org_assignment_count(&contributor, &org), 1);

    s.client.complete_assignment(&maintainer, &contributor, &org, &99u32);
    assert!(!s.client.is_assigned(&contributor, &org, &99u32));
    assert_eq!(s.client.get_org_assignment_count(&contributor, &org), 0);
}

#[test]
fn contracts_smoke_assign_revoke() {
    let env = Env::default();
    let s = Setup::new(&env);
    let admin = Address::generate(&env);
    let maintainer = Address::generate(&env);
    let contributor = Address::generate(&env);
    let org = s.org("myorg");

    s.client.initialize(&admin);
    s.client.register_maintainer(&admin, &maintainer, &org);
    s.client.apply_for_issue(&contributor, &org, &55u32);
    s.client.assign_issue(&maintainer, &contributor, &org, &55u32);
    s.client.revoke_assignment(&maintainer, &contributor, &org, &55u32);

    assert!(!s.client.is_assigned(&contributor, &org, &55u32));
    assert_eq!(s.client.get_org_assignment_count(&contributor, &org), 0);
}
