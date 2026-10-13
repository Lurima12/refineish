# Refineish

An add-on for **Dash to Dock** (and Ubuntu Dock) for GNOME Shell 45-50, with Flourish.

- **Gaps**: separate margin between the dock and the bottom, left, right and top screen edges.
- **Style**: light, dark, or follow the system colour scheme, with adjustable colours and opacity.
- **Visibility**: independent options to hide the dock in Activities Overview and in the app grid.
- **Foreground**: colour of the Show Applications button icon (automatic or custom).
- **Border**: width, colour (automatic or custom), opacity and corner radius.
- **Running apps section**: three sections (pinned, running, and storage / mounted drives /
  trash) with a customizable separator line between each (thickness, length,
  colour, opacity). Pinned apps move into the running section while running and back
  when closed.

## Structure

    dash-to-dock-tweaks@lurim412/
    ├── metadata.json                      uuid, shell-version, settings-schema
    ├── extension.js                       enable()/disable(), gaps, style, border
    ├── runningSection.js                  pinned / running sections + separator
    ├── styleSlot.js                       non-destructive inline style helper
    ├── layout.js                          pure ordering logic (unit-tested)
    ├── prefs.js                           Adw preferences (Gaps, Appearance)
    ├── schemas/…gschema.xml               settings
    └── README.md

## Install

```
git clone https://github.com/Lurima12/refineish.git refineish@lurim412
cp -r refineish@lurim412 ~/.local/share/gnome-shell/extensions

# log out and back in (Wayland) or Alt+F2, r, Enter (X11), then:
gnome-extensions enable dash-to-dock-tweaks@lurim412
```

Dash to Dock must be installed and enabled.

## How it works

The extension does not import or patch Dash to Dock. It finds the dock actor and adds
style declarations (margins, colours, border) to the dock background. disable()
restores every change.

## Flourish compatibility

Flourish animates the dock icons (hover, press, launch) and lifts the dash's icon
clipping. This extension never touches icon transforms, clipping or
`animateLaunch`, and only re-orders existing icon actors with `set_child_at_index()`,
so both extensions can run together in any order.

## Troubleshooting

If the dock glitches, turn features off one at a time (all gaps to 0, "Separate running
apps" off, background override off, border off) to find the culprit, enable "Log debug
messages" on the Troubleshooting page and watch
`journalctl -f -o cat /usr/bin/gnome-shell`.

The extension waits for the Shell's startup animation to finish before touching the dock.

## Hiding in the overview

The dock is faded out and clipped away; the extension never touches the dock's `visible`
property, which the Shell and Dash to Dock manage themselves (fullscreen apps, workspace
switches, autohide).

## Gaps and autohide

Gaps follow Dash to Dock's own stylesheet: on the side facing the screen edge the dock
background gets a margin and every icon button gets the same amount of extra padding.
The padding is part of the icons' layout, so the dock grows and the gap stays inside the
dock's hover box, screen-edge barrier and struts, which keeps autohide / intelligent hide
working. (A margin on the background alone only shrinks the background over the icons;
moving the dock actor makes the pointer in the gap miss the dock and autohide bounce.)
Only the gap for the dock's current position is used.

## Dynamic Music Pill and other dock widgets

Dynamic Music Pill puts its widget inside the dock's hover box, next to the dash, centred on
that box. The box is taller than the icons (Dash to Dock pads the icon buttons more on the
screen-edge side, and a gap adds to that), so the widget would not line up with the icons.
The extension measures the centre of the app icons and the centre of the widget from the
layout and adds a small transform that centres the widget on the icons. It is applied on top
of whatever the add-on does itself, so the pill's own offset settings keep working, and it
works wherever the widget sits in the dock (first, last or at an index). It can be turned off
on the Gaps page.

## Separator lines

The separators are plain widgets in the icon box with no margins, like the stock separator.
They are centred on the icons (the shift is read from the icon buttons' real padding, so it
follows the gap, dock position and dock style) and their length is a percentage of the icon
size, so they follow the dock. (Spacing and offset options were removed: they caused the icons to
squish while hovering.)

## Known limitations

- A pinned app counts as running once its state is RUNNING (not while STARTING),
  so its launch animation plays in the pinned section first.

- Gaps move the dock actor. Enable "Reserve the gap as screen space" to keep
  maximized windows clear of it (only in Dash to Dock's always-visible mode).
- GNOME Shell's CSS has no dashed or dotted border style.
- Dash to Dock may rename internal actors in future releases. If the dock is not
  detected, update `DOCK_ACTOR_NAME` / `BACKGROUND_STYLE_CLASS` in extension.js.
- The icon labels and running-indicator colours are left to Dash to Dock.

## License

GPL-2.0-or-later (required for extensions.gnome.org).
