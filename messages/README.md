# Message catalogs

Wobble ships English (`en`, the base locale) and Latin American Spanish (`es-419`). The
catalogs are plain JSON; Paraglide compiles them into typed message functions at build
time. No catalog is fetched at runtime.

## Where messages live

- `messages/en.json` and `messages/es-419.json`: shared messages (shell, navigation,
  routes, Assessment labels, domain and common vocabulary).
- `messages/<locale>/<feature>.json`: one file per feature surface, listed explicitly in
  `project.inlang/settings.json`. Keep a feature's English and Spanish files in step.

## Authoring rules

- IDs are stable, semantic, snake_case, and namespaced with a feature prefix
  (`workers_*`, `overview_*`, `mapping_*`, `configuration_*`, `settings_*`,
  `native_*`, `onboarding_*`).
- A message is one complete phrase with named parameters, for example
  `"workers_selected": "{count} trabajadores seleccionados"`. Never concatenate
  translated fragments or lowercase a translated label to manufacture grammar.
- Counting messages use complete variants selected by the locale's plural rules. Do not
  append an English or Spanish suffix to a translated noun.
- Interpolated Worker names, Notes, Attribute labels, answers, Agitations, Languages and
  Worksite names are plain text. They are never translated, normalized, or treated as
  markup.
- Keep the same keys and parameter names in both catalogs. `npm run i18n:check` reports
  missing entries and parameter/plural mismatches; the build fails if a message function
  is called with the wrong inputs.

## Terminology (Spanish)

| Concept                   | Spanish                          | Status                                                                                                                              |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Leader / Leaders          | Líder / Líderes                  | Fixed user decision; never Grupo central.                                                                                           |
| Activist / Activists      | Activista / Activistas           | Source-attested.                                                                                                                    |
| Supporter / Supporters    | Simpatizante / Simpatizantes     | Source-attested.                                                                                                                    |
| Disengaged                | Distante / Distantes             | Source-attested.                                                                                                                    |
| Hostile                   | Hostil / Hostiles                | Source-attested.                                                                                                                    |
| Unassessed                | Sin evaluar                      | Provisional Wobble wording; not a scale standing.                                                                                   |
| Worksite                  | Lugar de trabajo                 | Source-attested phrase, applied to Wobble's container.                                                                              |
| Worker                    | Trabajador                       | Source-attested.                                                                                                                    |
| Relationship              | Relación                         | Source-attested concept, Wobble's symmetric meaning.                                                                                |
| Mapping                   | Mapa                             | Provisional short navigation label.                                                                                                 |
| Organizing Committee      | Comité organizador               | Provisional compound label.                                                                                                         |
| Committee coverage        | Cobertura del comité organizador | Provisional; Wobble's own metric.                                                                                                   |
| Agitations                | Asuntos laborales                | Provisional interface wording; explains the workplace problems that matter to a Worker. Do not use Agitaciones for the stored list. |
| Worker's spoken Languages | Idiomas                          | Distinct from the interface language.                                                                                               |

The full references and evidence status are in
`../.scratch/multilingual/spanish-terminology.md`. Independent linguistic review is not
available for this release; the table distinguishes fixed decisions, source-backed terms,
and provisional wording.

## Commands

- `npm run i18n:compile` generates `src/lib/paraglide` (git-ignored).
- `npm run i18n:check` checks catalogs.
- `npm run check`, `npm test`, and the Playwright suites are the behavior gates.

## Adding a language

Add the locale to `project.inlang/settings.json`, create its root and feature files,
extend the registry's `language` choices, and extend the locale resolver's supported
families. Do not add a second locale detector in a feature. Right-to-left support needs
its own acceptance pass; the metadata and logical properties are prepared, but no RTL
catalog ships.

## Stress catalog

`npm run i18n:pseudo` writes a git-ignored `en-XA` catalog by expanding the English
messages. It is a development/test aid, not a release language and not a saved preference;
build with `VITE_WOBBLE_PSEUDO_LOCALE=1` to apply it for `e2e/i18n-stress.spec.ts`.
