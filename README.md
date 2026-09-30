# Undaunted: a Dauntless 1.12.0 private server

A self-hosted backend that keeps the Dauntless 1.12.0 PC client
(`rel-1.12.0`, CL392819) playable after the official servers shut down. It is a
community preservation fork of
[SyST3MDeV/Undaunted](https://github.com/SyST3MDeV/Undaunted), played regularly
by a small group.

This is the `1.12` branch, the project's main line. The server for the older
`1.4.4_shipping` client (CL239827) lives on the
[`1.4.4`](https://github.com/Harmonicrain/Undaunted/tree/1.4.4) branch.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by Phoenix Labs. The repository
> contains no game client or game assets. You need your own installed copy of the
> 1.12.0 client. The game data the servers read (identifiers, tables, tuning and
> names) is included in [`data/1.12`](data/1.12) for interoperability, with its
> provenance (see [Game data](#game-data)).

## Contents

- [Components](#components)
- [Features](#features)
- [Not supported yet](#not-supported-yet)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Game data](#game-data)
- [Development](#development)
- [License and attribution](#license-and-attribution)

## Components

| Directory | What it is |
| --- | --- |
| [`UndauntedMetagame`](UndauntedMetagame) | The backend service (Node.js, Express, SQLite). Accounts, characters, inventory, store, Hunt Pass, progression, challenges, escalation, parties, friends, chat and presence. |
| [`UndauntedDeployServer`](UndauntedDeployServer) | Launches and tracks world servers (Ramsgate, Training Grounds, hunt islands) and allocates them to matchmaking. |
| [`UndauntedRuntime-1.12`](UndauntedRuntime-1.12) | The DLL injected into the 1.12.0 client and world servers: points them at this backend and fixes or completes game behaviour the official services used to provide. |
| [`tools`](tools) | 1.12 scripts: the checked build and deployment workflow, starting the stack, launching a client and adding accounts. |
| [`docs`](docs) | The architecture guide, and dated session reports in [`docs/history`](docs/history). |

## Features

### Accounts and sign-in

- The Epic Online Services–style sign-in, account and display-name lookups the client expects.
- Per-user API keys (`AUTH_MODE=APIKEY`); `AUTH_MODE=NONE` is for local development and has no effect when `NODE_ENV=production`.
- Registration can be open, invite-code only or closed. Invite codes, users and online statistics are managed through an admin API under `/undaunted/api`.

### Characters and progression

- Character creation and versioned saves.
- Loadouts, cooldowns, breadcrumbs and discovered lore.
- Slayer's Path progress.
- Mastery and level tracks: XP, rank-ups with confirmation, objectives and pinned (tracked) objectives.
- New characters start as returning players in Ramsgate instead of being sent to the tutorial island (`SKIP_FTUE`).

### Inventory, currencies and the store

- Per-character inventory. Item grants, wallet charges and their receipts commit in one SQLite transaction, and a replayed transaction is recognised instead of applied twice.
- Account wallet for Platinum, notes, seasonal coins, event currencies and Aetherdust.
- Store catalogue organised by the tags the client asks for: the main store, the Reward Cache (priced in the season's coin), the Bazaar fountain's daily free bundle and Slayers Club.
- Offers can be priced in any wallet currency and limited to one purchase per day or per week.
- Entitlements, such as premium Hunt Pass access.

### Hunt Pass

- Seasons and their rewards are loaded from JSON files, so changing a reward does not need a rebuild.
- Free and premium tracks. Premium is unlocked by an entitlement, or given to everyone with `HUNT_PASS_PREMIUM_MODE=free`.
- Rank rewards are granted atomically and recorded in a claim ledger, so nothing is granted twice.
- The Hunt Pass selection screen. It offers the season's pass, running event passes and an optional permanent library of past passes, and remembers each player's choice.
- Slayer Link XP counts from the main pass or the player's chosen pass.

### Challenges and bounties

- Bounty boards persist between sessions and feed Hunt Pass XP.
- Daily challenges reset at 17:00 UTC.
- Weekly challenges rotate every Thursday at 18:00 UTC from a shared pool.

### Escalation

- Escalation progress is saved as season snapshots from the world server.
- A snapshot that no real play could produce, or that would erase newer progress, is refused.
- Each client build uses its own season registry.

### Middleman

- Cell exchanges paid in Aetherdust.
- Offers rotate weekly across cell families. With six or more families configured, no cell repeats in consecutive weeks.
- Fusion slots are saved and validated.

### Seasonal events

- An event is switched on for a date range from one file, and switches itself off when that range ends. It controls:
  - the event schedule the game reads;
  - the Ramsgate feature flags for the event's decorations and NPCs;
  - the event pass's availability window;
  - which store tabs (such as the event vendor's store) are open.
- World servers answer the game's "is this event running?" checks from the same schedule. That is what makes event quests, rumours and event pickups appear.
- Verified in game with Dark Harvest:
  - the Ramsgate decorations, the Mysterious Notes and Honest Ozz;
  - the event quests;
  - the ciphers and gifts around Ramsgate, and the rumour quests they unlock;
  - the Unseen Recruit event pass.

### Social

- Friends, blocked players and recent players.
- Presence and chat over XMPP, both as WebSocket on the HTTP port and as raw TCP.
- Parties: invite, accept, promote, kick, and travel together.
- Slayer Links: invites, links, reward pools and exactly-once reward delivery.

### Worlds and matchmaking

- The deploy server starts Ramsgate and the Training Grounds at boot and hunt islands on demand, each on a port from a configured UDP range.
- If Ramsgate or the Training Grounds exits, the deploy server starts it again. An island's port is freed for reuse when its world exits. An optional watchdog also catches worlds that exit without being noticed.
- World servers drop to a low frame rate while empty and shed client-only memory (render data, the embedded browser): about 855 MB for Ramsgate and 730 MB for the Training Grounds. See [docs/architecture-112.md](docs/architecture-112.md#world-server-cost).
- Hunt and Trials tables are selected per client build.
- Matchmaking follows the client's candidate flow, including regions and QoS checks.
- The runtime DLL redirects the client and world servers to this backend and carries fixes for replication, the HUD, loot summaries, the Hunt Pass and Middleman screens, and crash diagnostics.

## Not supported yet

These parts of the game either have no backend behind them or answer with an empty or fixed placeholder:

- Guilds
- Voice chat (Vivox)
- The message of the day and the mailbox
- Trials leaderboards (empty)
- Support-a-Creator
- Account migration
- The Platinum skip on rumour quests. The client reports "Error getting skip platinum price", but the quest itself works.
- Hunt Pass XP tuning (fixed defaults)

## Getting started

Requirements:

- Windows, with your own installed Dauntless 1.12.0 client (CL392819).
- [Node.js](https://nodejs.org/) 20.6 or later; the project is developed on Node.js 24.
- For the runtime DLL: Visual Studio 2022 Build Tools with the v143 toolset.

### Metagame and deploy server

Both are ordinary Node.js packages and are set up the same way:

```powershell
cd UndauntedMetagame
npm ci
copy .env.example .env    # then fill in the values, see Configuration
npm run build
npm start
```

Repeat in `UndauntedDeployServer`. The metagame creates its SQLite database and
runs its migrations on start.

### The 1.12 stack

The 1.12 scripts in [`tools`](tools) read your machine's paths from
`tools/local112.json`, which git ignores. Copy
[`tools/local112.example.json`](tools/local112.example.json) and set:

- `dataRoot`: a folder for `data/` (the database and account files) and `logs/`;
- `gameDirectory`: the 1.12.0 client's `Archon\Binaries\Win64` folder;
- `defaultAccount` (optional): the account `Start-Local112.ps1` launches a client for.

Parameters (`-DataRoot`, `-GameDirectory`) and environment variables
(`UNDAUNTED112_DATA_ROOT`, `UNDAUNTED112_GAME_DIR`) override the file. Ports come
from the packages' `.env` files.

```powershell
# Build and test both server packages and the runtime DLL together.
powershell -NoProfile -File tools/Build-Local112.ps1 -Test
# Then activate the fresh outputs and restart the servers, worlds and client.
powershell -NoProfile -File tools/Build-Local112.ps1 -Deploy -Restart

# Start the servers only, or with a client for an account.
powershell -NoProfile -File tools/Start-Local112.ps1 -ServerOnly
powershell -NoProfile -File tools/Start-Local112.ps1 -Account <Name>

# Add an account (the database is backed up first; the key is saved, never printed).
node tools/New-Account112.mjs <Name>
```

The build refuses a client executable other than the pinned 1.12.0 build (see
[`tools/client112.json`](tools/client112.json)). The
[1.12 architecture guide](docs/architecture-112.md) describes the workflow, the
runtime's layout and the diagnostic flags.

## Configuration

Each package reads a `.env` file; `.env.example` lists the basic keys. Never
commit a `.env` file: it holds signing keys and API keys.

### Metagame (`UndauntedMetagame/.env`)

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | HTTP listener. XMPP over WebSocket shares this port. |
| `XMPP_PORT` | Raw TCP XMPP listener (default `60002`). |
| `DB_FILENAME` | SQLite database file. |
| `AUTH_MODE` | `APIKEY`, or `NONE` for local development only. |
| `AUTH_SIGNING_PRIVKEY_B64`, `AUTH_SIGNING_PUBKEY_B64` | Token signing keys. |
| `REGISTRATION_MODE` | `OPEN`, `INVITECODE` or `NONE`. |
| `MATCHMAKING_MODE` | `DEPLOYSERVER` to allocate worlds from the deploy server, or `DISABLED`. |
| `DEPLOYSERVER_URL`, `QOS_TARGET_URL` | Where the deploy server and the QoS check are reached. |
| `TARGET_CHANGELIST`, `TARGET_BUILD_ID` | The client build being served (e.g. `392819` and `392819_rel-1.12.0_shipping`). |
| `STORE_OFFER_FORMAT` | `prices`, the 1.12.0 client's offer format (the default, `flat`, is 1.4.4's). |
| `SKIP_FTUE` | `true` to start new characters in Ramsgate instead of the tutorial island. |
| `ACTIVE_HUNT_PASS` | The season's Hunt Pass id. |
| `HUNT_PASS_PREMIUM_MODE` | `entitlement` (default) or `free`. |
| `STORE_DATA_DIR`, `HUNT_PASS_SEASONS_DIR`, `HUNT_PASS_LIBRARY_FILE`, `ESCALATION_SEASONS_FILE`, `LINKED_SLAYER_REWARDS_FILE`, `CHALLENGE_REWARDS_FILE`, `SEASONAL_EVENTS_FILE` | The 1.12.0 game data; `.env.example` points them at [`data/1.12`](#game-data). |
| `LOG_LEVEL`, `WIRE_CAPTURE` | Logging, and optional request capture for investigating what the client sends. |

### Deploy server (`UndauntedDeployServer/.env`)

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST`, `MY_IP` | Listener, and the address players are sent to. |
| `PORT_RANGE_BEGIN`, `PORT_RANGE_END` | UDP ports for world servers. |
| `GAMESERVER_BINARY_PATH` | The game executable used to run world servers. |
| `METAGAME_ADDRESS`, `METAGAME_API_KEY` | How world servers reach the metagame. |
| `SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP` | Delay between world launches. |
| `HUNT_DATA_DIR` | Hunt and Trials tables for the client being served. |
| `ENABLE_WATCHDOG`, `GAMESERVER_LOG_DIR`, `GAMESERVER_LOG_CMDS`, `LOG_LEVEL` | Watchdog and logging. |

## Game data

The 1.12.0 client's data is in [`data/1.12`](data/1.12), and the `.env.example`
files already point at it:

| Setting | Path (from the package folder) | Contents |
| --- | --- | --- |
| `STORE_DATA_DIR` | `../data/1.12/store` | `store_catalog.json` and `store_item_kinds.json` |
| `HUNT_PASS_SEASONS_DIR`, `HUNT_PASS_LIBRARY_FILE` | `../data/1.12/huntpass`, `../data/1.12/huntpass-library.json` | Hunt Pass seasons, and the library of past passes |
| `ESCALATION_SEASONS_FILE` | `../data/1.12/escalation/seasons.json` | Escalation season registry |
| `LINKED_SLAYER_REWARDS_FILE` | `../data/1.12/linked-slayer/linked_slayer_rewards.json` | Slayer Link reward table |
| `CHALLENGE_REWARDS_FILE` | `../data/1.12/challenges/challenge_rewards.json` | Daily and weekly challenge tables |
| `SEASONAL_EVENTS_FILE` | `../data/1.12/events/seasonal_events.json` | Seasonal events (below) |
| `HUNT_DATA_DIR` (deploy server) | `../data/1.12/hunts` | Hunt and Trials tables |

[`data/1.12/README.md`](data/1.12/README.md) records where each file comes from
and credits its sources. The packages' `src/vendor` folders still hold the 1.4.4
data, used only for a setting left unset.

### Seasonal events file

```json
{
  "events": [
    {
      "name": "Dark Harvest",
      "start": "2026-09-25T00:00:00Z",
      "end": "2026-11-06T00:00:00Z",
      "scheduledItems": ["EVENT_DARKHARVEST"],
      "featureFlags": ["city_event_dark_harvest_bpff", "city_event_stall_bpff"],
      "eventPasses": ["eventpass_unseenrecruit"],
      "storeTags": ["seasonal_event", "eventpass_unseenrecruit_pass"]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `scheduledItems` | Schedule ids the game checks, such as a quest series' event id. |
| `featureFlags` | Client feature flags the runtime DLL forces on while the event runs, such as Ramsgate's event levels. |
| `eventPasses` | Event passes offered with the event's dates. |
| `storeTags` | Store tags that are listed and sold only while the event runs. |

The metagame reads this file at start. The client and world servers read the
schedule and flags when they launch, so restart them after changing it.

## Development

- Run `npm run build` and then `npm test` in `UndauntedMetagame` and
  `UndauntedDeployServer`. GitHub Actions runs the same on every push and pull
  request. Tests use synthetic data and disposable databases under the system
  temp folder, never a live `.env` or player database; set
  `UNDAUNTED_PROTECTED_DATA_DIRS` to your live data folders for an extra guard.
- Database schema changes go through Drizzle migrations (`npm run db:generate`).
  They run automatically on start. Before applying pending migrations, or a
  data repair with rows to fix, startup copies the database next to itself
  (`<db>.bak-preMigration-…` or `<db>.bak-preRepair-…`).
- Never commit `.env` files, account keys, player databases or the generated
  SDK. Game data goes in `data/1.12`, with its source recorded in
  `data/1.12/README.md`.
- The runtime DLL is pinned to one executable build. Its function addresses are
  collected in `UndauntedRuntime-1.12/native/Addresses112.h`.

Further reading:

- [Working on the 1.12 runtime and servers](docs/architecture-112.md)
- [Session history](docs/history): dated investigation, cleanup and build reports
- [Runtime provenance](UndauntedRuntime-1.12/PROVENANCE.md)

## License and attribution

Licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`); see
[`LICENSE.txt`](LICENSE.txt). If you modify it and let people play on it over
a network, AGPL section 13 requires you to offer them the corresponding source.

Part of this repository is derived from Mystic Paradox and carries additional
terms under AGPLv3 Section 7; see [`NOTICE.md`](NOTICE.md) and
[`ADDITIONAL_TERMS.md`](ADDITIONAL_TERMS.md). This is a modified version and not
an official release of Undaunted or of Mystic Paradox.

"Mystic Paradox's Dauntless 1.12.0 port and related modifications were developed by
Pranav Karande. See NOTICE.md for contribution and provenance information."

Undaunted was originally created by gwog :3 ([SyST3MDeV](https://github.com/SyST3MDeV/Undaunted)).
Dauntless and related names belong to their respective owners.
