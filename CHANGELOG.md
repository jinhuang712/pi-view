# Changelog

All notable changes to `pid-view` are documented here.

This file starts at the rename; earlier history is in the git log.

## [Unreleased]

### Changed

- **Renamed to `pid-view`, with the migration to match.** The extension grew a half that only a
  graphical host loads, and the prefix says so. The command is now `/pid-view:config` and the
  configuration file is `~/.pi/agent/pid-view.json`. Nothing is asked of the user: a setting left at
  the old path is read when no new file sits beside it, and the next save writes the new name. The
  old file is left where it is — it is the user's, and deleting it would be this extension deciding
  that for them. A checkout installed by path keeps working once the path is updated;
  `pi install` from GitHub follows the repository's own redirect.

### Added

- **A graphical host gets the same row, drawn by this extension.** `renderCall` and `renderResult`
  return pi-tui components and only a terminal can mount one, so the extension ships a second half —
  `src/ui.tsx`, declared as `"pid": { "ui": … }` — which draws `view` out of the host's own row
  frame: the measurements as plain text, and a tinted `vision` pill when the picture was described by
  the configured vision model rather than read by the active one. A reader who misses that is reading
  someone else's words as the model's own, which is why it is a mark and the measurements are not. A
  call that was not routed shows no pill, and a host that does not load the second half draws its own
  generic row.
- `npm run typecheck` (`tsc --noEmit`) and a test suite for the configuration file, including the
  read-old-write-new migration. The repository had neither.
