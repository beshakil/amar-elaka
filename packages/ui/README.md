# @amar-elaka/ui

UI shared by `apps/admin` and `apps/web` (ADR 057): the DataTable (sorting, filtering, selection,
pagination, CSV export, on `@tanstack/react-table`) and the primitives it is built from. Shipped as
TypeScript source: each app lists it in `transpilePackages`, adds `@source` for Tailwind, and merges
`messages/bn.json` (the `dataTable.*` strings) into its catalog. The apps' `components/ui/*` re-export
these, so app code keeps importing `@/components/ui/button`.
