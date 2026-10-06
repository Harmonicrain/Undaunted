# Undaunted Launcher

Windows x64 launcher rewritten in Rust with Tauri 2 and Microsoft Edge WebView2.
The static frontend is in `frontend/`; native account, networking, game, settings
and signed update code is in `src/`. Electron and npm are no longer needed to
build or package the launcher. Node 24 runs the dependency-free build and test
scripts. Installed users need neither Node nor Rust.

## Configuration and build

Requires Rust MSVC, Visual Studio C++ Build Tools with the Windows SDK, Node 24
and WebView2. Packaging also requires NSIS 3 (`makensis.exe` on PATH, or configure
its location). Copy `launcher.local.example.json` to the ignored
`launcher.local.json` and set:

- `server`: your backend origin. Public servers require HTTPS; loopback, LAN and
  Tailscale IPs may use HTTP. No deployment address is committed.
- `gameDirectory`: your supported Dauntless 1.12.0 install or Win64 directory,
  containing the runtime DLLs built by `../tools/Build-Local112.ps1`.
- `assetsDirectory`: locally extracted art, fonts, icon and installer sidebar.
- `updateFeed`: null to disable updates, or an object with `url` (HTTPS folder),
  `requiresTailscale`, `publicKey` (Ed25519 PEM) and
  `appId: "community.undaunted.launcher112"`. Only the public key is bundled.
- `nsisCompiler`, `openssl`: tool names on PATH or explicit local paths.
- `keyFile`, `publishDir`: private signing key and public feed folder, used only
  when explicitly publishing. Keep the private key outside the public folder.
- `legacyElectronSource`: optional archived Electron checkout with its original
  dependencies, used only by the installed migration test.

Paths are relative to the local configuration file. `UNDAUNTED_LAUNCHER_CONFIG`
selects another config. Environment overrides are `UNDAUNTED_LAUNCHER_SERVER`,
`UNDAUNTED112_GAME_DIR`, `UNDAUNTED_LAUNCHER_ASSETS`, `UNDAUNTED_NSIS_COMPILER`,
`UNDAUNTED_OPENSSL` and `UNDAUNTED_LEGACY_LAUNCHER_SOURCE`.

Extract assets from your own game using Python 3, Pillow 9.1+ and an Oodle DLL:

```powershell
python scripts/extract-art.py --game <game-folder> --oodle <oo2core-dll>
node scripts/prepare-local.cjs
cargo run --locked
```

The prepare step verifies the game executable against `../tools/client112.json`
and generates ignored `ui/` and `resources/` folders. It bundles and hashes both
runtime DLLs. Game assets, DLLs, local paths and signing keys stay out of Git.
The fixed game hash/build, original application ID, installer GUID namespace
and profile names are compatibility contracts; changing them breaks existing
installations. The Discord invite is the community link, not a deployment host.

## Verification and release

```powershell
node --test test/build.test.cjs
cargo test --locked --lib --test parity
node test/run-local.cjs
node test/installed-update.cjs
node scripts/build-release.cjs
```

`run-local.cjs` needs a passing disposable backend stage under `../artifacts/`,
created by `../tools/Build-Local112.ps1 -Test`; `UNDAUNTED_TEST_STAGE` can select it.
It checks accounts, sessions, repair, settings and actual native UI states, with
offscreen screenshots and disposable databases. It never launches the real game.
The installed migration test additionally needs an archived Electron source tree
and OpenSSL. It upgrades the synthetic Electron 1.0.6 fixture to the configured
launcher version, then to the next patch version using another Rust fixture.
It uses its own application identity, installation folder, profiles, signing key,
private HTTPS feed and temporary TLS trust. No Windows certificate is installed.

CI uses `prepare-local.cjs --test-assets` to generate a small test icon and
loopback configuration, then runs build/unit checks without game assets or keys.
CI does not run the backend/UI/installer fixtures; run those locally for releases.

The release build runs build-script tests, Rust tests and backend/native UI checks,
then builds without `local-tests` and packages a native payload with standalone
NSIS. Artifacts and corresponding authored launcher/runtime source are written
under ignored `../artifacts/`. Building does not publish or install the application.
The current credits DLL is required. A configured signed update feed is required
for a production release.

After reviewing a release and its installed-update result, publish explicitly:

```powershell
node scripts/publish-release.cjs --artifact <release-artifact> --upgrade-test <upgrade-test-artifact> --publish
node scripts/publish-changelog.cjs --artifact <release-artifact> --publish
```

Publishing verifies the artifact and test evidence, refuses downgrades or changed
installer bytes under an existing version, and replaces signed `latest.json`
only after the complete installer is available. Increment both Cargo and Tauri
versions for each new release. The already published 1.0.8 is immutable.

## Installed-user compatibility

The native NSIS installer retains the original application ID, executable name
and per-user registry GUID. Existing Electron launchers using the signed feed can
install it through their update button. It verifies Microsoft's signed Evergreen
WebView2 bootstrapper and installs the prerequisite before removing the old app.
This prerequisite needs internet when WebView2 is missing; existing installations
remain intact if it fails. All-users installations require removal with their
original uninstaller before installing the per-user launcher.

First startup imports original settings and valid Chromium v10/DPAPI sessions
without overwriting an existing Rust profile or deleting the Electron profile.
Unreadable saved logins require sign-in again; valid folder/language settings
survive. Signed feed migration retains the packaged verification key.

Signed updates are checked and downloaded at startup. Installation requires
the user's Restart to update action with Dauntless closed. Both signed metadata
and cached installer bytes are verified. The included changelog describes the
Rust rewrite and remains readable offline. License and attribution notices are
included in the installer and corresponding source archive.
