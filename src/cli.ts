#!/usr/bin/env bun
// epic-fab — Linux-native CLI for Epic Games / Fab.com asset library.

const USAGE = `epic-fab — Epic Games / Fab.com asset library on Linux

Commands:
  auth                       Authenticate via Epic OAuth device-code grant
  list [--json]              List owned Fab assets
  download <asset-id> [...]  Download asset(s) to disk
  sync --project <path>      Bulk-download library into a UE project's Content/
  whoami                     Show current authenticated Epic account
  logout                     Delete persisted auth tokens

Options:
  -h, --help                 Show this help
  -v, --version              Show version
`;

const VERSION = "0.1.0";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help") {
    console.log(USAGE);
    return 0;
  }

  if (command === "-v" || command === "--version") {
    console.log(VERSION);
    return 0;
  }

  switch (command) {
    case "auth":
      console.error("auth: not yet implemented (pending Research findings on Epic OAuth)");
      return 2;
    case "list":
      console.error("list: not yet implemented (pending Fab API client)");
      return 2;
    case "download":
      console.error("download: not yet implemented (pending Fab API client)");
      return 2;
    case "sync":
      console.error("sync: not yet implemented (pending download module)");
      return 2;
    case "whoami":
      console.error("whoami: not yet implemented");
      return 2;
    case "logout":
      console.error("logout: not yet implemented");
      return 2;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
