# src/lib

Four layers, and a rule about which way imports may point:

- `shared/` — code more than one view needs. Imports nothing above it.
- `features/<view>/` — one view's own code. May use `shared/`, never another feature.
- `shell/` — the frame around every page. May use `shared/` and `features/`.
- `client/` — every call to the backend, over Tauri `invoke` into the Rust core (`crates/wobble-core`).

`components/ui/` is vendored shadcn-svelte, kept as upstream ships it — which is why the
app's own components are not under `components/`. `utils.ts` and `hooks/` sit here because
`components.json` pins them; do not move them.

`domain-vocabulary.ts` stays at this root on purpose. It is the shared Worker vocabulary,
and after the migration it is the shape the Rust side has to match.
