# Dauntless 1.12.0 game data

The data a 1.12 server reads, for the `1.12.0` client (`rel-1.12.0`,
changelist 392819, executable SHA-256
`EE30D1821B4020FF1BCAA89A63FA6EF3515EFB622F2969546B91BF018A379F43`, as pinned
in [`tools/client112.json`](../../tools/client112.json)).

Most of it was exported read-only from the installed client's paks; it holds
the identifiers, tables, tuning and names the servers need to interoperate with
the client, like the 1.4.4 data bundled in the packages' `vendor` folders. It
is Phoenix Labs' game data, included for interoperability. Nothing here is a
game asset (no models, textures, audio or maps).

Point the servers at it from the package folders, which is where they run:

| Setting | Value | Contents |
| --- | --- | --- |
| `STORE_DATA_DIR` | `../data/1.12/store` | The store catalogue and the grant kind of every item it sells |
| `HUNT_PASS_SEASONS_DIR` | `../data/1.12/huntpass` | Hunt Pass seasons and progression tracks |
| `HUNT_PASS_LIBRARY_FILE` | `../data/1.12/huntpass-library.json` | Past passes offered on the Hunt Pass selection screen |
| `ESCALATION_SEASONS_FILE` | `../data/1.12/escalation/seasons.json` | Escalation season registry |
| `LINKED_SLAYER_REWARDS_FILE` | `../data/1.12/linked-slayer/linked_slayer_rewards.json` | Slayer Link prize table |
| `CHALLENGE_REWARDS_FILE` | `../data/1.12/challenges/challenge_rewards.json` | Daily and weekly challenge tables |
| `SEASONAL_EVENTS_FILE` | `../data/1.12/events/seasonal_events.json` | Seasonal events (this server's schedule) |
| `HUNT_DATA_DIR` (deploy server) | `../data/1.12/hunts` | Hunt and Trials tables |

## Where each file comes from

| File | Source |
| --- | --- |
| `store/store_catalog.json`, `store/store_item_kinds.json` | Generated from the client's item catalogue and `StoreItemsTable` (tile art is looked up by SKU id). Prices, limits and the free offers are this server's choices. The items Honest Ozz's Event Store and the Reward Cache sell, their names and their prices follow the Dauntless Wiki. |
| `huntpass/progression-1.12.json` | The live service's progression config, captured in [EisigesEis/DauntlessEndpointDocumentation](https://github.com/EisigesEis/DauntlessEndpointDocumentation) (`Progression/Config.json`, commit `c0b5355`), kept to the tracks whose items all exist in the 1.12.0 catalogue. `season19` is the client's own Hunt Pass; only its end date is moved (to 2085) so it stays open. |
| `huntpass-library.json` | Built by [`tools/build-huntpass-library.mjs`](../../tools/build-huntpass-library.mjs) from the progression tracks, the client's Hunt Pass season table and its English localization (titles and descriptions). |
| `escalation/seasons.json` | `Archon_24-WindowsClient.pak`: `escalation_progression` (`FEscalationProgressionTuning` rows) and the talent tables each row names. |
| `linked-slayer/linked_slayer_rewards.json` | `Archon_UI_0-WindowsClient.pak`: `Social/LinkedSlayers/linked_slayer_rewards` and `linked_slayer_config`. |
| `challenges/challenge_rewards.json` | `Archon_24-WindowsClient.pak` `Gameplay/Bounty`: `challenge_seasons_daily_table`, `challenge_seasons_weekly_table`, `challenge_category_table`. |
| `events/seasonal_events.json` | This server's configuration. The event, feature flag, pass and store ids are the client's. |
| `hunts/*.json` | The client's player and matchmaker hunt and Trials tables, laid over the 1.4.4 tables the deploy server bundles (1.12.0 rows win; rows only 1.4.4 had stay, because some 1.12.0 hunts still name them). |

Each file's own `_comment` or `source` field repeats its origin where the format
allows one.

## Credits

- Live-service captures: [EisigesEis/DauntlessEndpointDocumentation](https://github.com/EisigesEis/DauntlessEndpointDocumentation).
- Store lists for Honest Ozz and the Reward Cache: the [Dauntless Wiki](https://dauntless.fandom.com/wiki/Reward_Cache)
  (Reward Cache and Dark Harvest pages).
- Dauntless and its data belong to their respective owners.
