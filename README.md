# epic-fab

Linux-native CLI for browsing and downloading your **Epic Games / Fab.com asset library** — no Epic Games Launcher required.

Built for Linux users running Unreal Engine who want programmatic access to assets they already own on [Fab](https://www.fab.com): Quixel Megascans, UE Marketplace purchases, free monthly drops, and any other Fab-distributed content tied to their Epic account.

## Why this exists

Epic Games has never shipped a Launcher for Linux. The Fab plugin and Quixel Bridge are launcher-distributed binaries — Linux users get locked out of an entire asset library they've already paid for or legitimately claimed. `epic-fab` closes that gap with a simple CLI that handles Epic OAuth + Fab API directly.

## Status

**Pre-alpha.** Auth scaffolding in progress. See `ISA.md` for the live ideal-state articulation and which criteria are met.

## Goals

- `epic-fab auth` — one-time login via Epic's OAuth device-code grant
- `epic-fab list` — show every asset in your library as JSON
- `epic-fab download <asset-id>` — download a single asset to a target directory
- `epic-fab sync --project <path-to-uproject>` — bulk download into a UE project's `Content/` tree

## Anti-goals

- **Not a launcher replacement.** No game downloads, no entitlement management beyond Fab/asset library scope.
- **Not a Fab marketplace browser UI.** CLI is the interface. UE editor integration is a separate optional layer.
- **No proprietary Epic code copied or redistributed.** All API calls are against documented or community-reverse-engineered public endpoints.
- **No Wine, no Heroic dependency, no Launcher protocol handlers.**

## Install (planned)

```bash
git clone https://github.com/starkslabs/epic-fab.git ~/Projects/epic-fab
cd ~/Projects/epic-fab
bun install
bun link              # makes `epic-fab` available globally
```

## Authentication

Uses Epic's [OAuth 2.0 device authorization grant](https://oauth.net/2/device-flow/). Run `epic-fab auth`, follow the printed URL, paste the user code, and approve in your normal browser. Tokens are persisted at `~/.config/epic-fab/auth.json` (mode 600) and refreshed automatically.

No credentials touch the CLI directly. No Epic Launcher needed.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgments

- The [Legendary](https://github.com/derrod/legendary) project documented the Epic OAuth endpoints used here.
- Built as a contribution to the [PAI ecosystem](https://github.com/danielmiessler/PAI) — Daniel Miessler's framework for personal AI infrastructure.
