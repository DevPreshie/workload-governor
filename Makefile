# Makefile — WorkloadGovernor contract development helpers
#
# Most CI steps live in .github/workflows/; this Makefile provides convenient
# local and CI entry points without requiring shell-script knowledge.
#
# Prerequisites:
#   - Rust stable  (cargo test, build)
#   - Rust nightly (cargo fuzz — libfuzzer requires nightly + LLVM sanitizers)
#   - cargo-fuzz:  cargo install cargo-fuzz --locked
#
# Usage:
#   make test          # run all contract tests
#   make build         # compile native (debug)
#   make build-wasm    # compile to wasm32v1-none (release)
#   make fuzz-apply    # fuzz apply_for_issue for FUZZ_SECS seconds (default 60)
#   make fuzz-ci       # same but 600 s — matches the nightly CI budget
#   make fuzz-list     # list all registered fuzz targets

.PHONY: all test build build-wasm \
        fuzz-apply fuzz-ci fuzz-list \
        verify-corpus generate-corpus \
        clean help

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

## Seconds to run the fuzzer locally (override with: make fuzz-apply FUZZ_SECS=120)
FUZZ_SECS ?= 60

## Seconds used in CI (nightly schedule)
FUZZ_CI_SECS ?= 600

## Fuzz target to run
FUZZ_TARGET ?= apply_for_issue

## Corpus directory for the active target
CORPUS_DIR := fuzz/corpus/$(FUZZ_TARGET)

## Artifacts directory
ARTIFACTS_DIR := fuzz/artifacts/$(FUZZ_TARGET)

# ---------------------------------------------------------------------------
# Default
# ---------------------------------------------------------------------------

all: build test

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

build:
	cargo build --features testutils

build-wasm:
	cargo build --target wasm32v1-none --release

# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

test:
	cargo test --features testutils

# ---------------------------------------------------------------------------
# Fuzz
# ---------------------------------------------------------------------------

## List all registered fuzz targets (requires cargo-fuzz on nightly)
fuzz-list:
	cargo +nightly fuzz list

## Regenerate all seed corpus files from the canonical definitions.
##
## Idempotent: re-running overwrites hand-crafted seeds and leaves any
## fuzzer-discovered inputs untouched.
##
##   make generate-corpus
##   make generate-corpus CORPUS_ROOT=/tmp/fresh-corpus
CORPUS_ROOT ?= fuzz/corpus

generate-corpus:
	python3 scripts/generate-corpus.py --corpus-dir $(CORPUS_ROOT)

## Verify that every seed in each corpus directory is accepted by its fuzz
## target without triggering a crash (uses `cargo fuzz run` with -runs=0
## which processes the corpus once in "seed mode" and exits cleanly).
##
## Prerequisites: cargo-fuzz installed, nightly toolchain available.
##
##   make verify-corpus
##   make verify-corpus CORPUS_ROOT=/tmp/custom-corpus
FUZZ_TARGETS_ALL := apply_for_issue fuzz_apply fuzz_assign fuzz_batch_apply \
                    fuzz_withdraw fuzz_revoke fuzz_lifecycle fuzz_admin_threshold

verify-corpus: fuzz-build
	@echo "==> Verifying corpus seeds for all fuzz targets (cargo fuzz run -runs=0)"
	@FAILED=0; \
	for target in $(FUZZ_TARGETS_ALL); do \
	  CORPUS=$(CORPUS_ROOT)/$$target; \
	  if [ -d "$$CORPUS" ] && [ "$$(ls -A $$CORPUS 2>/dev/null)" ]; then \
	    echo "  checking $$target ..."; \
	    cargo +nightly fuzz run $$target $$CORPUS -- -runs=0 2>&1 \
	      && echo "    [OK] $$target" \
	      || { echo "    [FAIL] $$target"; FAILED=$$((FAILED + 1)); }; \
	  else \
	    echo "  [SKIP] $$target — no corpus files in $$CORPUS"; \
	  fi; \
	done; \
	if [ $$FAILED -ne 0 ]; then \
	  echo ""; \
	  echo "ERROR: $$FAILED fuzz target(s) failed corpus verification."; \
	  exit 1; \
	else \
	  echo ""; \
	  echo "All corpus seeds verified successfully."; \
	fi

## Build the fuzz harness.
##
## Two-stage approach for memory-constrained environments:
##   Stage 1: build dependencies WITHOUT sancov instrumentation (avoids
##            OOM-killing the enormous stellar-xdr crate on 8 GB machines).
##   Stage 2: build the fuzz binary itself WITH sancov via cargo-fuzz.
##
## If Stage 2 fails due to OOM, the pre-built deps from Stage 1 are still
## used and the binary falls back to the plain --cfg fuzzing build which
## provides correct crash detection (though without coverage feedback).
fuzz-build:
	@echo "==> Stage 1: pre-build deps without sancov (avoids OOM on stellar-xdr)"
	RUSTFLAGS="--cfg fuzzing" cargo +nightly build \
	    --manifest-path fuzz/Cargo.toml \
	    --target x86_64-unknown-linux-gnu \
	    --release \
	    --bin $(FUZZ_TARGET)
	@echo "==> Stage 2: build fuzz binary with sancov coverage"
	cargo +nightly fuzz build --sanitizer none $(FUZZ_TARGET) || \
	    echo "WARNING: sancov build failed (OOM?); using plain --cfg fuzzing binary from stage 1"

## Run the apply_for_issue fuzz target locally for FUZZ_SECS seconds.
## Loads structured seeds from $(CORPUS_DIR) before random mutation.
##
##   make fuzz-apply            # 60 s default
##   make fuzz-apply FUZZ_SECS=300
fuzz-apply: fuzz-build
	mkdir -p $(ARTIFACTS_DIR)
	cargo +nightly fuzz run --sanitizer none $(FUZZ_TARGET) $(CORPUS_DIR) \
		-- -max_total_time=$(FUZZ_SECS) \
		   -print_final_stats=1 \
		   -artifact_prefix=$(ARTIFACTS_DIR)/ \
	|| target/x86_64-unknown-linux-gnu/release/$(FUZZ_TARGET) \
		   $(CORPUS_DIR) \
		   -max_total_time=$(FUZZ_SECS) \
		   -print_final_stats=1 \
		   -artifact_prefix=$(ARTIFACTS_DIR)/

## CI budget: 600 s — matches the nightly GitHub Actions schedule.
## Called by .github/workflows/contract-pipeline.yml fuzz job.
fuzz-ci:
	mkdir -p $(ARTIFACTS_DIR)
	RUSTFLAGS="--cfg fuzzing" cargo +nightly build \
	    --manifest-path fuzz/Cargo.toml \
	    --target x86_64-unknown-linux-gnu \
	    --release \
	    --bin $(FUZZ_TARGET)
	target/x86_64-unknown-linux-gnu/release/$(FUZZ_TARGET) \
		$(CORPUS_DIR) \
		-max_total_time=$(FUZZ_CI_SECS) \
		-print_final_stats=1 \
		-artifact_prefix=$(ARTIFACTS_DIR)/

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------

clean:
	cargo clean
	rm -rf fuzz/artifacts/

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

help:
	@echo ""
	@echo "WorkloadGovernor Makefile targets"
	@echo "----------------------------------"
	@echo "  all              Build + test (default)"
	@echo "  build            cargo build --features testutils"
	@echo "  build-wasm       cargo build --target wasm32v1-none --release"
	@echo "  test             cargo test --features testutils"
	@echo "  fuzz-list        List registered fuzz targets"
	@echo "  fuzz-build       Build the fuzz harness (two-stage, memory-safe)"
	@echo "  fuzz-apply       Fuzz apply_for_issue for FUZZ_SECS=$(FUZZ_SECS) seconds"
	@echo "  fuzz-ci          Fuzz apply_for_issue for FUZZ_CI_SECS=$(FUZZ_CI_SECS) seconds (CI budget)"
	@echo "  generate-corpus  Regenerate all 7 seed corpus files from canonical definitions"
	@echo "  verify-corpus    Run each fuzz target in seed-mode (-runs=0) to check all seeds are valid"
	@echo "  clean            Remove build artifacts and fuzz crash files"
	@echo ""
	@echo "Override fuzzing duration:  make fuzz-apply FUZZ_SECS=300"
	@echo "Override corpus root:       make generate-corpus CORPUS_ROOT=/tmp/my-corpus"
	@echo "Override corpus root:       make verify-corpus CORPUS_ROOT=/tmp/my-corpus"
