# Launcher verification — 6 October 2026

The published 1.0.8 release was authorized and verified before this repository
replacement. Its approximately 6.90 MiB installer, signed metadata and source
archive were read back through the actual HTTPS update feed. The published bytes
are unchanged by the repository cleanup. The release changelog describes the
Rust rewrite and the bundled runtime includes the private-server credits.

## Canonical Rust source

- Five dependency-free Node build checks pass: configuration paths, URL safety,
  stable version comparison, original installer GUID compatibility, signed
  publication, tampering, key mismatch, downgrade and immutable release checks.
- Rust updater unit test passes. All 19 parity checks pass with disposable
  backend, Chromium v10/DPAPI and NSIS argument fixtures enabled.
- Clippy passes for all targets with local test support and warnings denied.
- Clean copied source prepares generated test assets and passes Cargo checks
  without a local deployment config, game assets, DLLs or Electron dependencies.
- Native WebView2 smoke passes. Screenshots cover sign-in, registration and
  linking with scrolling, settings, news, signed-in/out states and minimum size.
  Sign-in, linking, settings and the Rust changelog screenshots were inspected.

The frontend, source and build scripts live under `UndauntedLauncher/`. Server
addresses, resource paths, tool paths and private release settings are supplied
through ignored local configuration. Standalone NSIS packaging retains the
original per-user installation identity without an Electron build dependency.
Only the optional migration fixture uses an explicitly configured legacy checkout.

## Installed updates

The isolated upgrade fixture passed Electron 1.0.6 → Rust 1.0.8 → Rust 1.0.9
through the actual update buttons and signed loopback HTTPS feed. It verifies
login, game folder and language retention, original profile preservation,
Electron runtime removal, relaunch, invalid signature rejection, altered cached
installer rejection and verified redownload. The installation path contains
spaces. The original installer's registry GUID matches, and standalone NSIS
packaging completed without warnings. The isolated installation was removed.
Each fixture has its own identity, profile, database and signing key;
temporary TLS trust exists only in copied test builds.

The credits DLL hash is
`712e9d375a37543d634f9f3cf68e4c4ddd90a86fad459f9552404575d71f4d2a`.
Local tests do not launch the real game, replace its DLL, edit a live database,
publish an update or restart the server. Missing-WebView2 bootstrapper execution
and all-users installation migration have not been tested on this machine;
WebView2 is already installed and the installer supports per-user upgrades.
