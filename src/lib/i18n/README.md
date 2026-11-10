# i18n

The one application-locale boundary.

- `locale.ts` resolves and freezes the applied locale for a launch, and sets the document's
  `lang`/`dir`. Feature code never detects or persists a locale.
- `route-copy.ts` maps stable route keys to page titles and subtitles, so a route load can
  finish before the shell freezes the locale.
- Generated message functions live in `src/lib/paraglide` (git-ignored; run
  `npm run i18n:compile`). Import them as `import { m } from '#lib/paraglide/messages.js'`.
- Catalogs are `messages/en.json` and `messages/es-419.json`. Both are maintained in the
  same change; `npm run i18n:check` reports missing or invalid entries.

## Names and parameters

Message ids are stable, semantic, snake-case, and namespaced by the surface they belong to
(for example `nav_workers`, `page_workers_title`, `workers_selected_count`). A message is
one complete sentence or label with named parameters; never build a sentence by
concatenating translated fragments or by lowercasing a translated label. Interpolated
Worker content is plain text and never becomes markup or a message id.

Domain labels shared by several views (Assessment, Committee coverage, Agitations) use a
shared message namespace and one display mapping, not a copy per view. Counting messages
use complete singular/plural variants selected by the locale's plural rules.

The application locale is distinct from a Worksite's spoken Languages vocabulary and from
the system's regional date, time, number and collation preferences. See the parent
specification for the policy.

## Development stress locale

`npm run i18n:pseudo` generates `messages/en-XA.json` and `messages/en-XA/*.json` from the
English catalogs; the files are git-ignored. `en-XA` is never a release choice or a saved
preference. Build or test with `VITE_WOBBLE_PSEUDO_LOCALE=1` to apply it; the e2e stress
spec is `e2e/i18n-stress.spec.ts`. It exercises expanded real messages, long user content,
mixed-direction names, the viewport floor and larger text. Without the environment
variable the app resolves its normal locale.
