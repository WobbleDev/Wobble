# shared

Code more than one part of the app needs. Folders:

- `text/`: wording and formatting helpers (text, abbreviations, `<id>:<value>` URL pairs, value formatting, the no-value reading, new ids).
- `workers/`: Worker filters and population, answer paths and hierarchy, Assessment colours, select modes, region identity and person state.
- `app/`: app settings, request headers, navigation, unsaved-changes tracking and scroll fade.
- `ui/`: small components used by more than one view (choice select, filter dropdown, icon tip, section card, swatch dot, unsaved-changes dialog).

This is the bottom layer. Nothing here may import from `features/`, `shell/`, `server/`
or `routes/` — if it needs to, it belongs somewhere higher.

Anything only one view uses belongs in that view's `features/` directory instead.
