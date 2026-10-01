# Scoop bucket

A [Scoop](https://scoop.sh/) bucket is just a repository with a `bucket/`
directory full of manifests, so Cairn's lives here rather than in a separate
`scoop-cairn` repo — one repo, no cross-repo token for CI to push with.

```powershell
scoop bucket add cairn https://github.com/drmowinckels/cairn
scoop install cairn/cairn-timetracker
```

## Why `cairn-timetracker` and not `cairn`

`scoop install cairn` already resolves to an unrelated app
([R0kshan/cairn](https://github.com/R0kshan/cairn)). A published manifest can't
be renamed without breaking every machine that installed under the old name, so
the suffix is there from the start — and keeps the door open to submitting to
Scoop's `extras` bucket later without a rename.

## What it installs

The portable `Cairn-<version>-x64-portable.zip` from the GitHub release, not
either Windows installer: Scoop extracts archives rather than running setup
programs, and the NSIS installer's own per-user location (#318) would fight
Scoop's `~/scoop/apps` layout.

Your data lives in `%APPDATA%\io.drmowinckels.cairn`, outside the Scoop app
directory, so `scoop uninstall` leaves your time entries alone.

## Maintenance

`cairn-timetracker.json` is generated, never hand-edited.
[`.github/workflows/scoop.yml`](../.github/workflows/scoop.yml) regenerates it
from [`scripts/scoop-manifest.mjs`](../scripts/scoop-manifest.mjs) whenever a
release is _published_, and commits the result. The manifest appears here after
the first release that ships a portable zip; until then this bucket is empty on
purpose, rather than advertising a download that 404s.
