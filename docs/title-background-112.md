# Animated title background (1.12)

The client DLL wraps `LoginScreen_bps_C.SplashImage` in a clipped Overlay inside
its existing SizeBox. It retains the SizeBox slot's padding and alignment and
leaves the logo, PLAY button, patch notes and other controls in their original
hierarchy. The original Malkarion texture remains the first slide.

Five additional season login textures are loaded from the installed game's paks
using reflected `MakeSoftObjectPath` / `LoadAsset_Blocking` functions. The paths
were verified in CL392819's `Archon_UI_1` and `Archon_UI_3` pak indexes:

- Season 08a (`ui_background_hp08a_loginscreen`)
- Season 09b (`ui_background_hp09b_commando_loginscreen`)
- Season 16a (`ui_hp_login_marauder_16A`)
- Season 17a (`ui_hp_login_terramane_17a`)
- Season 14a (`ui_hp_ranger_background_login`)

No new artwork, modified paks, server endpoint or launcher changes are required.
One texture loads per UI tick, and each is retained by an attached Image's brush.
Each new brush is initialized with the game's `SetBrushFromTexture` setter.
Do not copy the original brush and directly replace `ResourceObject`: its opaque
fields include a cached Slate render resource, which kept most slides drawing
Malkarion despite the correct texture pointer and animation timing. Live memory
showed four alternate slides sharing Malkarion's cached handle. Only the original
brush's size and tint are copied through reflected setters.
Unavailable textures are skipped. If the original hierarchy cannot be wrapped,
the original static background remains.

The Blueprint has no scripted Tick. Its Construct event enables the SDK's
`bHasScriptImplementedTick` flag and `TickFrequency = Auto` before native
construction finishes; the reflected base `UMG.UserWidget.Tick` event then drives
the animation on the game thread. Animation work is guarded against reentrant
events and stops for a hidden or destructed screen. No background thread or
executable RVA is added.

Each cycle holds for ten seconds then crossfades for two seconds with smoothstep
easing. The current slide slowly scales from 1.01 to 1.04 around its centre;
clipping prevents it spilling outside the existing background area. Incoming art
starts at 1.01. Overlay draw order determines which layer fades, keeping the
lower layer opaque so even the final-to-first transition avoids exposing black.

`test/title-background-timing.test.cpp` checks hold timing, midpoint blending,
slide boundaries, wraparound, invalid time/single-slide inputs, zoom bounds and
opaque coverage throughout a complete six-slide loop. Runtime logs use the
`[TitleBackground]` prefix for wrapping, loading, the first tick and slide changes.
Use an isolated test client for visual validation before publishing any DLL.
