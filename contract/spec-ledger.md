# Spec ledger (B03, regenerated from `git ls-files`)

Generated with:

```sh
git ls-files 'src/lib/server/**/*.spec.ts' 'src/routes/**/*.spec.ts' 'src/hooks.server.spec.ts'
git ls-files 'src/lib/client/*.spec.ts'
```

Each row is a target for Stage C (a Rust test or a scenario in
`contract/fixtures/scenarios.json`) or a deliberate retire. `C01`–`C09` are the Stage C
tickets; `§6.n` is a scenario checklist item.

## Server specs

| Spec                                                      | Asserts                     | Disposition                                                      |
| --------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `src/lib/server/workers/schema.spec.ts`                   | DDL, seed, migrations       | C02 (v12 create + seed); the v6–v11 migration cases retire (D10) |
| `src/lib/server/workers/worksite-service.spec.ts`         | worksite CRUD/resolve       | C04                                                              |
| `src/lib/server/workers/attribute-persistence.spec.ts`    | attribute replace/migration | C05                                                              |
| `src/lib/server/workers/serialization.spec.ts`            | guards                      | C03                                                              |
| `src/lib/server/workers/service.spec.ts`                  | worker CRUD                 | C08                                                              |
| `src/lib/server/workers/agitation-persistence.spec.ts`    | idempotent create/replace   | C06                                                              |
| `src/lib/server/workers/language-persistence.spec.ts`     | idempotent create/replace   | C06                                                              |
| `src/lib/server/workers/assembly.spec.ts`                 | read + validate-on-read     | C07                                                              |
| `src/lib/server/workers/worker-request.spec.ts`           | decode + trim               | C03                                                              |
| `src/lib/server/workers/relationship-persistence.spec.ts` | pairs/symmetry              | C07                                                              |
| `src/lib/server/workers/utils.spec.ts`                    | parseStoredJson             | C03/C07                                                          |

## Route specs

| Spec                                                     | Asserts                  | Disposition                     |
| -------------------------------------------------------- | ------------------------ | ------------------------------- |
| `src/routes/api/worksite/save-worksite.spec.ts`          | worksite save handlers   | C04 + scenarios §6.1/§6.2/§6.14 |
| `src/routes/api/worksite/delete-worksite.spec.ts`        | delete + survivor        | C04 + scenarios §6.8/§6.11      |
| `src/routes/api/worksite/active/active-worksite.spec.ts` | selection validates only | C04 + scenarios §6.1/§6.2       |
| `src/routes/api/dataset/dataset.spec.ts`                 | dataset empty/populated  | C04/C07 + scenarios §6.15       |

## Files that need a Rust equivalent

| File                                                               | Asserts                | Disposition                       |
| ------------------------------------------------------------------ | ---------------------- | --------------------------------- |
| `src/lib/server/workers/test-database.ts` (`useTemporaryDatabase`) | temp-DB fixture + seed | needs a Rust equivalent (C01/C02) |

## Stays in Vitest (no Rust equivalent)

| Spec                                             | Why                                                     |
| ------------------------------------------------ | ------------------------------------------------------- |
| `src/routes/layout.spec.ts`                      | theme tokens (`oklch`, `color-mix`) — CSS, not the core |
| `src/lib/client/api-decode.spec.ts`              | TS client decode                                        |
| `src/lib/client/workers-api.spec.ts`             | TS client calls                                         |
| `src/lib/client/settings-api.spec.ts`            | TS client calls                                         |
| `src/lib/client/worksite-api.spec.ts`            | TS client calls                                         |
| `src/lib/client/dataset-api.spec.ts`             | TS client decode                                        |
| `src/lib/client/active-worksite-storage.spec.ts` | webview storage                                         |
| `src/lib/client/transport.spec.ts`               | http/tauri transport seam                               |

## Retired

| Spec                                     | Why                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `src/lib/server/active-worksite.spec.ts` | cookie transport retired with D3/A04                                       |
| `src/hooks.server.spec.ts`               | cookie/worksite hook retired with D3/A04; theming moved to app.html in A06 |
| `src/lib/contract/scenarios.spec.ts`     | the B02 recorder/replayer deleted with the Node server in G01 (`087544d`)  |
