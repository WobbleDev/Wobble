# contact-import

Reading a CSV of Contacts and creating the Worksite's Workers from it: the dialog, the
column mapping, the preview, and the parsing rules.

A Contact is not a Worker until the import creates one (see GLOSSARY.md). The shell
header's import action and Overview's setup dialog both use this. It lives in the Workers
feature because it creates Workers through the workers client; `shared/` may not import
features, and the shell and Overview may import it from here.

## Review and commit

`csv-import-review.ts` (pure) holds each row's disposition (imports, imports with Phone blank, skipped), the Problems-only pages and the two downloads; the downloads are built from row numbers, field roles and problem codes, so no cell value can reach them. `contact-import-model.svelte.ts` owns the behaviour behind a host. The commit sends only accepted rows, each with its source row, plus the Attribute ids the review saw. The core re-reads the Worksite and the live Attribute definitions inside the commit transaction and refuses with `import_stale_vocabulary`, creating nothing, when they differ. It answers the created ids against their source rows, in order; "View imported Workers" opens the first and keeps the ids as a private cohort (`open-created-workers.ts`).

## Attributes and duplicates

A CSV column can be mapped to each existing Attribute (`attribute-cell.ts`: the grammar is in its header and in ticket 22). A cell names answers of that Attribute only; a token that matches no answer, matches more than one, or cannot be held with another is a problem for the review. The organizer chooses per row (or for all rows at once) to leave those answers out or skip the row; nothing is created or guessed, and the commit is held while any row is undecided. The core decodes every row's answers against the live definitions inside the commit transaction and answers `import_stale_vocabulary`, creating nothing, if any is gone.

`duplicate-signals.ts` suggests Workers already in the Worksite that a row may be: same phone, same email, similar name, each listed with its reasons in a fixed order and no score. The organizer skips the row or creates it separately. Nothing merges here; "Compare with existing" opens each created Worker beside its candidates for the manual merge.
