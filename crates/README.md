# Rust crates

Conventions for the Rust port (D8):

- One module per area of the core's persistence and request handling; each module's header comment says what it owns.
- `rusqlite` with the `bundled` feature, plus `serde`, `serde_json`, `uuid` (v4).
- One error enum: `wobble_core::Error`.
- No `unsafe`, no `async`, no macros beyond `derive`.
- Gates for every Rust commit: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test`, plus the JS gates (`npm run lint`, `npm run check`, `npm test`).
