//! Event re-exports for the `contracts/` shim.
//!
//! All event emitters are defined in the workspace root crate.
//! This module re-exports them so that any downstream code referencing
//! `workload_governor_contracts::events` continues to compile unchanged.

pub use workload_governor::events::*;
