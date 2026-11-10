# app-header

The bar across the top of every page and what sits inside it: the breadcrumbs and the
theme switcher.

`src/routes/+layout.svelte` places it. The breadcrumbs follow the current route, and the
theme switcher writes the installation-wide Theme setting through `shared/app-settings.ts`.
