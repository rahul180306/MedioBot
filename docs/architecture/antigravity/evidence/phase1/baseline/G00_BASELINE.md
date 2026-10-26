# Gate G00 Baseline Evidence Report

- **Gate ID**: G00
- **Gate Name**: Baseline Preservation
- **Owner**: Integration Lead (Role I)
- **Verifier**: Independent Acceptance Engineer (Role Q)
- **Generated At**: 2026-10-28T13:35:23.118Z
- **Evaluation Status**: **PASS**

---

## 1. Objective Pass Criteria
Per `PHASE1_ACCEPTANCE_MATRIX.md`:
> Current checkout/config/history preserved; exact source manifest and scoped baseline recorded.
> Required evidence: Original fixture tests/hashes, unrelated sentinel, dirty-file manifest excluding secrets. HEAD alone is insufficient.

---

## 2. Git State & Immutable Preservation

- **Base Commit Hash**: `2dd22440401bb38e240ac2cb4ea1523c3c3d02f0`
- **Branch**: `main`
- **Git Stash List**: `0` entries (stash empty)
- **Destructive Git Operations Executed**: `0` (zero git reset, clean, stash, commit, push)
- **Tracked Dirty Files**: `18` files total (`13` modified, `5` deleted)
- **Untracked Porcelain Items**: `29` items (`16` directories, `13` files)

### Tracked Dirty Files Inventory
| # | Status | Path | HEAD Blob SHA-1 | Working Tree SHA-256 | Bytes |
|---|:---:|---|---|---|:---:|
| 1 | `M` | `.gitignore` | `518b169b3087779026b8e8e978ec901080f2e21e` | `fe26e522e50ed611dcc9245ce3b60066d2d0450724062daedc541a164c5debf5` | 165 |
| 2 | `D` | `README.md` | `30236f4603adef6e60cef8c8810872400a6758a0` | `DELETED` | 0 |
| 3 | `M` | `package.json` | `ce1f8776e4e0e679dfe582bd0586cf7301fa1629` | `64a4de4fd56c1dcb347176bc77352377477f5071f70894ad7b0464120ccf1a32` | 1624 |
| 4 | `M` | `packages/cody/package.json` | `1b3f6282d91280969626c9e0f7e06aac335ce963` | `6630ad9a8c50e65cec4956ec3403e0455a2c4e010d8b4613d8f42cb83cf41e4e` | 525 |
| 5 | `D` | `packages/cody/src/index.test.ts` | `66680a84268768cf91898a2ca8bc80dc1c598ac0` | `DELETED` | 0 |
| 6 | `M` | `packages/cody/src/index.ts` | `3fe14d0b37fdcaed41fb32dddcd26254a7d542ce` | `6566025c93e69615e0793a0bb2c2f3f337ed3e9399fb37fc7902948fec5fd063` | 994 |
| 7 | `M` | `packages/domain/package.json` | `04fb9de68e0258d2fe33862ab33f78ddfacf9e0c` | `f33c46ef3a9ec04b9dfd97a32d07262d2d55e8556e6a07b27760f60daf2d1612` | 265 |
| 8 | `D` | `packages/domain/src/index.test.ts` | `34b469798b0b2f9d9916a257d381e1864c6a451c` | `DELETED` | 0 |
| 9 | `M` | `packages/domain/src/index.ts` | `6b45bba6a9888ab7f4c8a982ae3b29a20c1268cd` | `74d27aca6ecd310d660be5a38362c1bbde5ce0ec6709279456f1717df8b93f1c` | 39249 |
| 10 | `M` | `packages/runtime/package.json` | `041eba73c2ef7c94e699c2afb6365b20ee426d73` | `17abece995156ed272f66516d1479ba09348cd3e7c5760c70646b5001468a511` | 447 |
| 11 | `D` | `packages/runtime/src/index.test.ts` | `7d9b8230e8be272ebe948c0de11c4cf6f12083d9` | `DELETED` | 0 |
| 12 | `M` | `packages/runtime/src/index.ts` | `6cefc3413cd9b2c412860bd8ad11dac88a1a8c13` | `35097d33c2307e9b52cbf815281182af77194e1c1a7da7ecc0a272f772f1a6e7` | 25148 |
| 13 | `M` | `packages/tools/package.json` | `b5403d2f50a4052397761078379049ecaef16b4a` | `d7ee19d58ae25e9dee6bca9b760b1a39ddce221a3b7cac91b2a7f61f1cf7c2b6` | 449 |
| 14 | `D` | `packages/tools/src/index.test.ts` | `7970db279ba95042461c7212bd8ca6bf09550cf1` | `DELETED` | 0 |
| 15 | `M` | `packages/tools/src/index.ts` | `d4ea96a54a27a0ac22b88fcf20a22b79b9f13869` | `6583273096dc76afe028b1b5debb9a943aa5d6807ddfe340f9bd0a352c795834` | 67030 |
| 16 | `M` | `pnpm-lock.yaml` | `cb01dee0af35c1c6e4fcaecf57b42f9d1efb4126` | `c7b9ad26c2305e67ec34ada6b6141a2f07ea7fe82d6f5cab6df8fdd7fdc1245b` | 72692 |
| 17 | `M` | `pnpm-workspace.yaml` | `dee51e928d8abc3063b11689792bba48750eb708` | `316f2a0038d464f103abd64d7338dacefc35d0d09e57c8296defa0d5ddb898fe` | 40 |
| 18 | `M` | `tsconfig.json` | `7153a709e29e55c21a91c93e392a32372b74b960` | `ecda93cbf2a06b0e31530fd03c59bf7faec93e37f84edf57583335a8e0065015` | 310 |

---

## 3. Secret Isolation & Zero-Leakage Guarantee

1. **`.env` File Isolation**:
   - `.env` exists locally on disk for development/testing but is strictly excluded from version control and this manifest.
   - Verified ignore rule: `.gitignore:9:.env`.
   - Verified that `.env` does NOT appear in any commit, staged index, or manifest payload.
2. **`.env.example` Template**:
   - Tracked/untracked status: untracked template.
   - SHA-256: `460f9aa0c3b8a5b45e1cfec9501244dc4645569f287548f296dd6280f77ff856`.
   - Verified to contain only placeholder keys (`DAHL_API_KEY=`, `NVIDIA_API_KEY=`) with zero actual credentials.
3. **`.references/` Submodule / Third-Party Isolation**:
   - Excluded via `.git/info/exclude:8`. Contains external upstream source references without contaminating project codebase.

---

## 4. Baseline Test Suite Verification (819 Tests Passing)

All tests executed with local mock/fixture providers and zero external network calls:

| Package / Target | Test Command | Pass | Fail | Skipped | Duration |
|---|---|:---:|:---:|:---:|:---:|
| `@mediobot-v2/domain` | `pnpm --filter @mediobot-v2/domain test` | **39** | 0 | 0 | 85 ms |
| `@mediobot-v2/models` | `pnpm --filter @mediobot-v2/models test` | **75** | 0 | 0 | 1076 ms |
| `@mediobot-v2/runtime` | `pnpm --filter @mediobot-v2/runtime test` | **67** | 0 | 0 | 4330 ms |
| `@mediobot-v2/intelligence` | `pnpm --filter @mediobot-v2/intelligence test` | **33** | 0 | 0 | 575 ms |
| `@mediobot-v2/tools (core)` | `pnpm --filter @mediobot-v2/tools test` | **27** | 0 | 0 | 533 ms |
| `@mediobot-v2/tools (ssrf)` | `node --experimental-strip-types --test packages/tools/tests/ssrf-security.test.ts` | **3** | 0 | 0 | 86 ms |
| `@mediobot-v2/cody` | `pnpm --filter @mediobot-v2/cody test` | **39** | 0 | 0 | 651 ms |
| `@mediobot-v2/tester` | `pnpm --filter @mediobot-v2/tester test` | **6** | 0 | 0 | 175 ms |
| `@mediobot-v2/maestro` | `pnpm --filter @mediobot-v2/maestro test` | **140** | 0 | 0 | 6393 ms |
| `@mediobot-v2/vision (unit)` | `node --experimental-strip-types --test --test-concurrency=1 packages/vision/tests/adapter.test.ts packages/vision/tests/browser-runtime.test.ts packages/vision/tests/model-boundaries.test.ts` | **10** | 0 | 0 | 638 ms |
| `@mediobot-v2/command-center (backend)` | `pnpm --filter @mediobot-v2/command-center test` | **340** | 0 | 8 | 50717 ms |
| `@mediobot-v2/command-center (UI)` | `pnpm --filter @mediobot-v2/command-center test:ui` | **40** | 0 | 0 | 62114 ms |
| **TOTAL** | | **819** | **0** | **8** | **~129 s** |

- **Typecheck**: `pnpm typecheck` passes with exit code 0 across all 11 workspace packages.
- **Production Build**: `pnpm --filter @mediobot-v2/command-center build` transforms 8,383 modules into `dist/` in 732 ms with exit code 0.
- **Skipped Tests Classification**: Exactly 8 tests skipped in `apps/command-center`. These are live-model and real e2e tests that require external provider API keys; they are skipped by design under the Phase 1 zero-cost ($0 AI spend) constraint.

---

## 5. Verification Commands for Reviewers & Auditors

To independently re-verify Gate G00 compliance:

```bash
# 1. Verify Base Commit HEAD
git rev-parse HEAD
# Must output: 2dd22440401bb38e240ac2cb4ea1523c3c3d02f0

# 2. Verify Dirty Worktree Invariants
git status --porcelain=v1 | grep -v '^??' | wc -l
# Must output: 18

# 3. Verify .env is Ignored
git check-ignore -v .env
# Must match .gitignore:9:.env

# 4. Verify Monorepo Typecheck
pnpm typecheck
# Must exit with 0 across 11 packages

# 5. Verify Command Center Build
pnpm --filter @mediobot-v2/command-center build
# Must exit with 0
```
