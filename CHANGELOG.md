# Changelog

All notable changes to **epic-fab** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Unreal Engine compatibility.** epic-fab tracks the Epic / Fab asset library,
> which moves with Unreal Engine. When a new UE release is detected, a
> compatibility entry is added below noting which UE version was validated.

## [Unreleased]

### Added
- `--engine <version>` for `download` and `sync` (default `UE_5.7`) with format
  validation, automatic fallback to the highest compatible version, and an
  interactive prompt when only higher engine versions exist.
  Thanks to [@renan-renger](https://github.com/renan-renger) (#1).
- `--concurrency <n>` (1–64) and `--no-skip` for `download` and `sync`.
  Thanks to [@Me-Maped](https://github.com/Me-Maped) (#2).
- Files already on disk with a matching size and SHA1 are skipped by default;
  `--no-skip` forces a rewrite.
- Retry with exponential backoff, falling through to remaining CDN distribution
  bases on transient failure.
- `SECURITY.md` — token storage posture, disclosure process, and the
  no-network-listener design rule.
- `bun run guard` (`scripts/no-listener-guard.ts`) — fails the build if a network
  listener is introduced into `src/`. Wired into CI.

### Fixed
- Out-of-memory on large assets (e.g. Content Examples). Chunks are now
  refcount-evicted from a bounded cache, prefetch uses a sliding window instead
  of resolving every GUID up front, and files stream to `<name>.partial` with an
  incremental SHA1 before an atomic rename.
- CDN chunk concurrency was effectively 1 — a serial `await` per part left
  `CHUNK_CONCURRENCY` unused. A sliding prefetch window now keeps the pool busy.
- Fallback to higher engine versions never triggered, because `bestScore` started
  at `-1`.

### Changed
- Progress and status now go to stderr; stdout stays JSON-pipeable and the
  download result includes `skipped`.

### Security
- Declined the local web UI proposed in #2. It called `Bun.serve({ port })`
  without a `hostname`, which binds `0.0.0.0`, and exposed four state-changing
  POST routes with no Origin, Host, or CSRF validation while the process holds
  Epic OAuth tokens. See `SECURITY.md` for the analysis and for the four
  requirements any future local UI must meet.

## [0.1.1] - 2026-06-04

### Changed
- Validated against Unreal Engine 5.7.4. (Compatibility check: confirm asset list + download still work against the new engine release.)

## [0.1.0] - 2026-05-21

### Added
- Initial Linux-native CLI for browsing and downloading your Epic Games / Fab
  asset library, without the Epic Games Launcher.
- Validated against Unreal Engine 5.7.

[Unreleased]: https://github.com/StarksLabs/epic-fab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/StarksLabs/epic-fab/releases/tag/v0.1.0
