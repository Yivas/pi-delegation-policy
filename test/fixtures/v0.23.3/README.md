# Previous-release configuration reader

`config.ts` and `types.ts` are copies from this repository's `v0.23.3` tag. Keep their parsing and restoration behavior unchanged: regression tests use the actual previous reader to check that a save with three advisors falls back to Advisor 1 after a downgrade instead of misreading the list. These fixtures are not distributed in the npm package.
