# shared

Code more than one part of the app needs: the Assessment colours, the app settings
types, the `<id>:<value>` URL shape, value formatting, worker-filter parsing, and CSV
contact import.

This is the bottom layer. Nothing here may import from `features/`, `shell/`, `server/`
or `routes/` — if it needs to, it belongs somewhere higher.

Anything only one view uses belongs in that view's `features/` directory instead.
