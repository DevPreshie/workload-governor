//! WorkloadGovernor — `contracts/` re-export shim.
//!
//! This crate re-exports the canonical smart-contract implementation from the
//! workspace root crate (`workload-governor`).  All contract logic, error
//! types, storage helpers and events live in `src/lib.rs` at the workspace
//! root; this package exists so that the Stellar CLI and other external
//! tooling can reference `--package contracts` without
//! duplicating or diverging from that implementation.
//!
//! **Do not add contract logic here.**  Changes to behaviour must be made in
//! `../src/lib.rs`.

#![no_std]

// Re-export the contract struct so that the Soroban SDK `#[contractimpl]`
// metadata (required for `contractimpl` expansion in WASM compilation units)
// is visible here.
pub use workload_governor::WorkloadGovernor;

// Re-export public sub-modules so downstream consumers can reference
// `workload_governor_contracts::errors::ContractError` etc. unchanged.
pub use workload_governor::errors;
pub use workload_governor::events;

#[cfg(test)]
mod test;
