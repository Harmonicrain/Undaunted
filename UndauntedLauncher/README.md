# Undaunted Launcher — Dauntless 1.12.0

A Windows x64 installer for registration, password login, claiming an existing
account without changing its identity, selecting a supported game installation,
installing/repairing the runtime and launching the game. The game itself is not
included. A supported 1.12.0 (CL392819) installation is required.

## Player flow

1. Connect to the host through LAN or Tailscale.
2. Install and open the launcher.
3. Create an account, or sign in. An existing player uses **Already play here?**
   to import the account JSON file or enter their existing account key and set a password.
4. Locate the installed game. The launcher accepts the installation root, Archon
   directory or Binaries/Win64 folder and verifies the executable's SHA-256.
5. Click Play. The launcher obtains a 60-second single-use exchange code, installs
   the bundled runtime if necessary, and starts the game without a shell.

## Build

Node 24.7+ is required for the backend's built-in Argon2id. The launcher bundles
Electron and does not require players to install Node. Install its own dependencies
here; do not install dependencies in the metagame's junction to the live 1.4.4 server.

```powershell
Set-Location UndauntedLauncher
npm ci
npm run prepare:runtime -- --server http://100.64.1.2:61000
npm test
npm run package
```

The launcher's artwork and fonts come from the game itself: five season login
screens, the Dauntless logo, the gold and metal button textures, and the
Goldenbook and Roboto Condensed fonts the client's UI uses. They belong to the
game, so they are not in the repository. Copy them out of your own 1.12.0
installation into the ignored `src/art/` before packaging:

```powershell
python scripts/extract-art.py --game <Dauntless 1.12.0 folder> --oodle <oo2core_*_win64.dll>
```

It needs Python 3 with Pillow 9.1 or later, and only reads the paks. The game
links Oodle statically, so `--oodle` (or `OODLE_DLL`) points at an
`oo2core_*_win64.dll` from another Unreal game. Without `src/art/` the launcher
still works, with plain colours and system fonts.

`prepare:runtime` reads `tools/local112.json` for the verified game directory, or
accepts `--game-directory`. It copies the host's installed `winmm.dll` and
`UndauntedInternalServer.dll`, hashes them and copies the licensing notices.
The ignored `resources/server.json` contains only the launcher API origin.
Never include environment files, databases or account files in a player release.

The NSIS installer is under `release/`. It has no Windows publisher certificate
or SmartScreen reputation. It bundles a pinned runtime and checks the bundle and
installation hashes. Launcher updates use separate Ed25519 release signatures;
these do not provide Windows publisher signing. It does not install the base game
or download remote DLLs independently of a verified launcher release.

## Launcher updates

Players install 1.0.6 manually once. Installed launchers check at startup and
download newer releases in the background. **Restart to update** installs and
reopens the launcher, preserving the encrypted login, game folder and settings.
Installation waits until Dauntless is closed, including clients started outside
the launcher. Closing the launcher does not automatically install an update.
Failed checks/downloads can be retried and do not prevent playing.

The packaged `resources/updates.json` fixes the trusted HTTPS feed and public
verification key. Changing the game server does not change the update feed.
Release metadata is signed, downloads are restricted to that HTTPS folder,
and the installer size and SHA-512 are verified before installation. Metadata
cannot supply arbitrary executables, arguments or download URLs.

Configure the host once, retaining the generated private key outside the source
repository and outside the served directory:

```powershell
npm run configure:updates -- --feed https://<host>.<tailnet>.ts.net/launcher/ --tailscale true
tailscale serve --bg --https=443 --set-path=/launcher '<dataRoot>\data\launcher-updates'
```

Enable HTTPS/Serve in the Tailscale admin page when prompted; leave Funnel off.
Only the public update folder is served. Back up the private signing key securely;
losing it requires a manual trust-key replacement for installed players. Its
contents must never be shared. The ignored `release.local.json` records local
key/output paths, while only the public verification key goes into installers.
Shared friends need TCP 443 to this host in the tailnet access policy, in addition
to the existing game ports. Keep access scoped to the shared host.

For every release, increment `package.json` and the matching lockfile version,
write release notes to a text file, then run:

```powershell
npm run release -- --notes-file <release-notes.txt>
```

This runs launcher tests and a disposable backend smoke test, prepares the verified
runtime, builds NSIS, signs the release, and copies it to the update folder. It
publishes `latest.json` last, after the installer is complete. Keep older installers
and blockmaps for differential updates. Never replace an installer with different
bytes under the same version. This workflow does not restart game servers.

For production HTTPS, use `--tailscale false` and a normal HTTPS folder URL with
the same signing key. The updater then requires no Tailscale client. Existing
private-feed users can receive a signed bridge release: publish to their existing
feed with `npm run release -- --next-feed <feed-migration.json>`. That JSON contains
`{"url":"https://updates.example.com/launcher/","requiresTailscale":false}`.
Put the signed release files on both hosts and keep the old feed available until
players have installed the bridge. A successful bridge install saves signed
migration metadata; later launches verify it before switching feeds. Game-server
HTTPS/runtime support remains a separate deployment task.

To test the actual Windows upgrade flow without touching the installed launcher:

```powershell
$env:UNDAUNTED_TEST_STAGE = '<repo>\artifacts\<tested-build>\UndauntedMetagame'
npm run test:installed-update
```

This builds isolated test apps, serves a signed test release over local HTTPS,
performs the NSIS upgrade/relaunch and verifies login/settings preservation.
Test-only certificate exceptions and debugging hooks stay in ignored artifacts;
production retains certificate validation. The test never starts the game.

## Backend

`/launcher/v1/status`, `/register`, `/login`, `/claim`, `/refresh`, `/logout`,
`/me` and `/exchange` are served by the existing metagame. Use `AUTH_MODE=APIKEY`.
`REGISTRATION_MODE` controls new accounts (`OPEN`, `INVITECODE`, `NONE`). Existing
accounts can still sign in or claim while registration is closed.

Migration `0026_launcher_accounts` adds three tables. Startup backs up the existing
database before migration. Passwords use salted Argon2id (19 MiB, two passes,
one lane); session tokens and exchange codes are stored as SHA-256 hashes.
Access sessions expire after 15 minutes; refresh sessions after 30 days. Refresh
rotates both tokens and revokes the previous session. Logout also revokes unused
exchange codes. The game receives only a one-time exchange code, never the
password or permanent account key. Existing script keys remain valid but cannot
reset the password once claimed. Password recovery currently requires the owner;
there is no email collection, password-reset mail or automatic recovery flow.

Both launcher and legacy registration enforce case-insensitive uniqueness,
3–16 character names and atomic invitation consumption. Shared per-IP throttling
covers login, claim and both registration routes. The password hash concurrency
limit is released only after hashing completes, even if the request disconnects.
Do not enable Express proxy trust without restricting it to your actual proxy.

The renderer is local-only, sandboxed, with Node integration disabled, a restrictive
CSP and a narrow sender-checked IPC interface. Refresh tokens are DPAPI-encrypted
on Windows and never enter the renderer. Passwords are never saved.

## Verification

Run `tools/Build-Local112.ps1 -Test` from the repository root. Backend tests use
disposable databases and cover account preservation, duplicate names, invite
races, expired/replaced/replayed codes, legacy compatibility, logout, refresh
rotation, malformed bodies and throttling.

For a hidden real-Electron smoke test against a staged disposable backend:

```powershell
$env:UNDAUNTED_TEST_STAGE = '<repo>\artifacts\<tested-build>\UndauntedMetagame'
$env:UNDAUNTED_TEST_SCREENSHOT = '<repo>\artifacts\launcher-preview.png'
npm run smoke
```

This verifies the preload sandbox, account flow, actual encrypted session file
and restoration after reopening the window. It never starts the game or touches
the live player database.

## Tailscale

Use the host's Tailscale IPv4 address as the server origin. HTTP is accepted only
for loopback, RFC1918 LAN addresses, and Tailscale's `100.64.0.0/10` range. Before
connecting to a Tailscale address the launcher checks that Tailscale is running
and the host is present in the local device/peer list. The numeric address keeps
the original runtime's host-and-port parsing compatible.

Set the deploy server's `MY_IP` to the Tailscale address; it is advertised to
clients for every world. Set `QOS_TARGET_URL` to the metagame's Tailscale address.
The deploy server listener and world-to-metagame address should stay on loopback.
Restart the stack after changes, with the owner's approval and a player check.

Allow TCP metagame/XMPP and UDP world ports only on the Tailscale interface. The
elevated `tools/Configure-TailscaleFirewall112.ps1` installs these scoped rules.
Share the host machine, rather than inviting friends into the owner's tailnet.
In the Tailscale access policy, limit `autogroup:shared` to those same ports and
avoid wildcard rules that also match shared users. A recipient may receive a
different shared-node IP if it conflicts in their tailnet; use the host address
shown on their device in that unusual case.

This preserves the runtime's current HTTP transport inside an encrypted private
tunnel. Direct public play needs a separate deployment and runtime HTTPS work.
An offsite friend's actual connection and hunt join remain the final remote test.

The launcher was written for this fork; no launcher or account-authentication
source was copied from Mystic Paradox. The bundled runtime retains its existing
AGPL license, additional terms, required attribution and provenance notices.
