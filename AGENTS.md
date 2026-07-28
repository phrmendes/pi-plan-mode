# Agent Notes

- Tests: `pnpm test` (node:test, no framework — tests drive the extension through a stubbed pi/ctx)
- Typecheck: `pnpm run typecheck` (strict, TypeScript 7 native)
- TDD: failing test first, then implement
- Comments only as JSDoc on declarations; document behavior through test and variable names
- `src/index.ts` is the only extension entry point; keep it dependency-light
