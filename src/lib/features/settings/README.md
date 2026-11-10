# features/settings

The building blocks of the Settings page: `settings-well.svelte` is the card each section sits in, `settings-row.svelte` is one labelled setting, and `settings-switch.svelte` is the on/off control. The page itself is `src/routes/settings/+page.svelte`. A row marked `unavailable` keeps its control disabled and shows "Not available yet" beside it.

Settings are installation-wide, not per Worksite. Theme, Density, Reset, the Accessibility controls (Reduce motion, Increase contrast, Color-blind Assessment colors and Text size), Date format and Time format, and the data controls (the database file's real path and details, Copy path, Restore, Erase all data, and the clipboard copies of the details) are live. Show in Finder, Remember window and Reset window are live in the desktop app; Restore also needs it, because it opens the operating system's file picker. Automatic backup, Updates, App lock, the Diagnostics log actions and Open-source licences are not available yet: they are one line each in the collapsed "Not available yet" well (second-to-last), with no controls and no state. What a Worksite asks about its Workers belongs to Configuration.

The Data row reads the path the core was opened with from `GET /api/data-file` and shows it verbatim; Copy path uses the clipboard API with a textarea fallback. Show in Finder calls the shell's `reveal_data_file` command, which runs the platform's reveal (macOS `open -R`, Windows `explorer /select,`, Linux `xdg-open` on the folder), so the control is hidden in the browser dev shim.

Restore calls `POST /api/restore` with the path chosen in the desktop open dialog and Erase calls `POST /api/erase`. The core writes a safety copy beside the database first — `<database>.pre-restore-<yyyymmddThhmmss>.sqlite` or `<database>.pre-erase-<yyyymmddThhmmss>.sqlite` — and the dialog shows the exact path with a Reload button (`window.location.reload()`). Erase keeps the typed `erase` confirmation and also clears the Active Worksite from webview storage. Restore is unavailable in the shim (the native picker is not); Erase works there, which is how the settings e2e drives it.

Remember window is read by the desktop shell straight from the SQLite file at launch, before the window-state plugin is built, so turning it off skips the restore without a request. Reset window is a Tauri command that clears the plugin's saved state and restores the default 1280×832 centred window. Both controls are hidden in the browser dev shim, whose "Startup and window" well shows a desktop-only sentence instead.

Date format and Time format reach the app through `src/lib/shared/format.ts`, whose `formatDate`, `formatTime` and `formatTimestamp` take the saved preferences. The two Note components read them from the settings context and pass them in, so a Note's "Written …" and "Edited …" text and its edit/delete labels follow the setting.

The Accessibility controls write root attributes that the CSS and the motion store read: `data-motion` (`system`/`reduce`/`full`), `data-contrast="on"`, `data-text-size` and `data-assessment-palette="colorblind"`. `src/app.html` applies the same mapping from the local appearance cache before first paint, and `settings-sync.svelte.ts` reconciles it after load; keep the two in step.

## Wells

Each section of the page is a component under `wells/`, in page order: `data-well`, `backups-well`, `privacy-well` (data and recovery), `theme-well`, `density-well`, `accessibility-well`, `region-well` (appearance), `general-well`, `diagnostics-well`, `shortcuts-well`, `about-well` (installation), `unavailable-well` and `reset-well`. The page keeps the section index and its scroll-follow, the search (`settings-search.ts`, matched against each well's own text; Enter jumps to the first match), plus the loaded `runtime` details. Live wells read the `settings` context themselves. Diagnostics and about take `runtime`; `shortcut-metadata.ts` owns the shortcut list. Each dialog lives in the well that opens it: Restore in backups, Reset settings and Erase in reset. Each well keeps its own copied and error state (`copy-feedback.svelte.ts`).

Shared pieces beside the building blocks: `picker.svelte` (a select bound to a row), `choice-set.svelte` (the Theme and Density toggle cards), `row-context.ts` (the described-by list a row and its control share), `data-error-notice.svelte`, `choice.ts`, `copy-text.ts`, `reload-page.ts` and `runtime-details.ts` (the About rows and the text Copy writes).

This feature owns the Settings page's building blocks and its wells.
