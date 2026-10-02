# Community patch notes

The title-screen patch-notes viewer fetches
`GET /patchnotes/<language>/<buildId>`. Its header, category buttons, sections
and bullet points already exist in the 1.12.0 client.

Edit `en.json` to publish the current community update. The metagame defaults to
this directory; `PATCH_NOTES_DIR` can point to another directory. Changed files
are validated and reloaded on the next request, without a server restart.
An incomplete/invalid edit keeps the last valid content while the server runs.
If no valid content is available, the client receives a short recovery notice.

The game can cache notes during a session. Restart the client and open the
patch-notes screen to verify a newly published update. Server hot reload does
not force an already open screen to refresh.

## Content format

- Top level: `date` (ISO timestamp), `title`, `release_version`, `language`,
  `description`, `permalink`, and a nonempty `notes` array.
- Each category: a unique `type`, a `title`, and nonempty `sections`.
- Each section: `type`, `title`, `description`, optional `background`, `cta`
  and `url` strings, and a `changes` array.
- Each change: `comment` and `list`, an array of bullet-point strings.

Use plain text initially. This is Unreal's native rich-text UI, not a Markdown
or HTML page. Empty optional section strings are supplied by the server.
Keep sections short enough to read comfortably in the game's scroll panel.
The JSON file is limited to 256 KiB. Do not put account data or credentials in it.

The schema was verified against CL392819's native serializers:
payload RVA `0x1AEFBF0`, category `0x1AEF830`, section `0x1AEFFE0`, change
`0x1AEF7C0`. Categories use `sections`, sections use `changes`, and change
bullets use `list`. `PatchNotesPopupWidget` already supplies separate category
and content scroll boxes. No client runtime change is required for this format.

## Languages and versions

Add a file such as `fr.json` or `fr-fr.json` and set its `language` to the same
normalized lowercase locale. Requests try the region, then the base language,
then English. Unsupported or invalid language parameters fall back to English.
The selected content's actual language is returned in the payload.

`buildId` remains the existing compatibility route parameter. It does not select
an arbitrary file. `release_version` is the visible update label; keep it at
`1.12.0` for these client notes, and use the date/title/sections to describe
community revisions. This endpoint publishes the current update, not an archive.

The initial notes describe implemented launcher features, this update screen,
connection requirements and known limitations. Unimplemented fixes should stay
under Known Issues rather than being announced as completed.
