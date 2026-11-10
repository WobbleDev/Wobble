# shell

The frame every page sits inside: the sidebar, the app header, and the page header.

This layer may import `shared/` and `features/` — the sidebar reads the configuration
draft, and the header opens the worker form and the contact import. `features/` may never
import `shell/`, so nothing here can be depended on from below.

To change the navigation or the Worksite switcher, start in `navigation-rail.svelte`.
