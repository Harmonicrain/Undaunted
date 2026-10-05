# Random loading artwork (1.12)

Normal Ramsgate and hunt loading screens choose one background when they open,
from the same six installed textures listed in `client/BackgroundArt.h` for the
title-screen slideshow. The image remains fixed throughout that load; there is
no animation work added during travel. Within one client session the next choice
is uniformly drawn from all backgrounds except the previous choice.

The client hooks CL392819's native `ArchonLoadingScreen::ScreenFadeIn` at the
already documented `Native112::LoadingScreenFadeIn` address, with a checked
ten-byte prologue. Disassembly confirms that ordinary CITY/ISLAND modes select
`DefaultLoadingScreen` (+0x388) in `WidgetSwitcherImage` (+0x3E0). The hook calls
the original function first, then updates only the active background's texture
using `UImage::SetBrushFromTexture`. Size, tint, opacity, animations, hint text,
party UI and the loading indicator retain their original behavior.

QUICK, WHITE and FTUE modes keep the game's transition and tutorial treatment.
Missing textures, a different active image or an unexpected native signature
leave the existing artwork unchanged. The hook installs only in the client;
world servers retain their existing loading-widget guard.

`test/loading-background-choice.test.cpp` exhaustively checks candidate mapping
for pools of two through ten images, with and without a previous choice. Every
eligible candidate maps exactly once, the previous choice is excluded, and
empty/single-image pools have a defined fallback. Runtime verification should
include at least two normal loading-screen presentations: `[LoadingBackground]`
logs the selected index and mode, and screenshots should show distinct art while
tips and the indicator remain present.

Keep this feature in the isolated test client until approved for distribution.
No launcher version, update feed, server data or original pak files are changed.
