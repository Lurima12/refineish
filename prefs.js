// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function spinRow(settings, key, title, subtitle, lower, upper) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, options) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(o => o[1])),
    });
    const sync = () => {
        const i = options.findIndex(o => o[0] === settings.get_string(key));
        row.selected = i < 0 ? 0 : i;
    };
    sync();
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({
        valign: Gtk.Align.CENTER,
        dialog: new Gtk.ColorDialog({withAlpha: false}),
    });
    const sync = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)))
            button.set_rgba(rgba);
    };
    sync();
    button.connect('notify::rgba', () => {
        const c = button.get_rgba();
        const value = `rgb(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)})`;
        if (value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, sync);
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function dependOn(settings, key, rows) {
    for (const row of rows)
        settings.bind(key, row, 'sensitive', Gio.SettingsBindFlags.GET);
}

export default class DashToDockTweaksPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.connect('close-request', () => {
            window._settings = null;
        });
        window.set_default_size(560, 720);

        // ---- Gaps ----------------------------------------------------------
        const gaps = new Adw.PreferencesPage({
            title: _('Gaps'),
            icon_name: 'view-fullscreen-symbolic',
        });

        const gapGroup = new Adw.PreferencesGroup({
            title: _('Space around the dock'),
            description: _('Distance between the dock and the screen edge it sits on. Only the ' +
                'value for the dock\'s current position is used; the others are kept for when you ' +
                'move the dock. The gap is part of the dock itself, so autohide / intelligent ' +
                'hide keep working.'),
        });
        const gapsOn = switchRow(settings, 'gaps-enabled', _('Override the dock gaps'),
            _('Off: Dash to Dock decides. On: the value below is used exactly (0 = flush with the edge).'));
        const gapRows = [
            spinRow(settings, 'gap-bottom', _('Bottom'), _('Pixels'), 0, 200),
            spinRow(settings, 'gap-left', _('Left'), _('Pixels'), 0, 200),
            spinRow(settings, 'gap-right', _('Right'), _('Pixels'), 0, 200),
            spinRow(settings, 'gap-top', _('Top'), _('Pixels'), 0, 200),
        ];
        gapGroup.add(gapsOn);
        for (const row of gapRows)
            gapGroup.add(row);
        dependOn(settings, 'gaps-enabled', gapRows);
        gaps.add(gapGroup);

        const followGroup = new Adw.PreferencesGroup({title: _('Compatibility')});
        const follow = switchRow(settings, 'follow-dock-widgets',
            _('Align other add-ons\' dock widgets with the app icons'),
            _('Centres widgets such as Dynamic Music Pill on the app icons, also when a gap is set.'));
        followGroup.add(follow);
        gaps.add(followGroup);
        window.add(gaps);

        // ---- Appearance -----------------------------------------------------
        const look = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const bgGroup = new Adw.PreferencesGroup({title: _('Background')});
        const manage = switchRow(settings, 'manage-background', _('Override the dock background'),
            _('Turn off to keep the colour chosen in Dash to Dock.'));
        const mode = comboRow(settings, 'style-mode', _('Style'), [
            ['system', _('Follow system')],
            ['light', _('Light')],
            ['dark', _('Dark')],
        ]);
        const light = colorRow(settings, 'light-color', _('Light colour'));
        const dark = colorRow(settings, 'dark-color', _('Dark colour'));
        const opacity = spinRow(settings, 'background-opacity', _('Opacity'), _('Percent'), 0, 100);
        for (const row of [manage, mode, light, dark, opacity])
            bgGroup.add(row);
        dependOn(settings, 'manage-background', [mode, light, dark, opacity]);
        look.add(bgGroup);

        const fgGroup = new Adw.PreferencesGroup({
            title: _('Foreground'),
            description: _('Colour of the Show Applications button icon (e.g. the Ubuntu logo). ' +
                'Only symbolic icons can be recoloured.'),
        });
        const fgOn = switchRow(settings, 'manage-foreground', _('Override the icon colour'));
        const fgMode = comboRow(settings, 'foreground-mode', _('Colour'), [
            ['auto', _('Automatic (dark on light, white on dark)')],
            ['custom', _('Custom')],
        ]);
        const fgColor = colorRow(settings, 'foreground-color', _('Custom colour'));
        for (const row of [fgOn, fgMode, fgColor])
            fgGroup.add(row);
        dependOn(settings, 'manage-foreground', [fgMode, fgColor]);
        look.add(fgGroup);

        const borderGroup = new Adw.PreferencesGroup({
            title: _('Border'),
            description: _('GNOME Shell styling supports border width, colour and corner radius ' +
                '(not dashed or dotted lines).'),
        });
        const borderOn = switchRow(settings, 'border-enabled', _('Customize the border'));
        const width = spinRow(settings, 'border-width', _('Width'), _('Pixels'), 0, 20);
        const colorMode = comboRow(settings, 'border-color-mode', _('Colour'), [
            ['auto', _('Automatic (matches style)')],
            ['custom', _('Custom')],
        ]);
        const custom = colorRow(settings, 'border-color', _('Custom colour'));
        const borderOpacity = spinRow(settings, 'border-opacity', _('Opacity'), _('Percent'), 0, 100);
        for (const row of [borderOn, width, colorMode, custom, borderOpacity])
            borderGroup.add(row);
        dependOn(settings, 'border-enabled', [width, colorMode, custom, borderOpacity]);
        look.add(borderGroup);

        const shapeGroup = new Adw.PreferencesGroup({title: _('Shape')});
        const radiusOn = switchRow(settings, 'override-radius', _('Override the corner radius'));
        const radius = spinRow(settings, 'border-radius', _('Corner radius'), _('Pixels'), 0, 60);
        shapeGroup.add(radiusOn);
        shapeGroup.add(radius);
        dependOn(settings, 'override-radius', [radius]);
        look.add(shapeGroup);

        window.add(look);

        // ---- Running apps -----------------------------------------------------
        const running = new Adw.PreferencesPage({
            title: _('Running apps'),
            icon_name: 'view-list-symbolic',
        });

        const sectionGroup = new Adw.PreferencesGroup({
            title: _('Sections'),
            description: _('Pinned apps move to the running section while they run and ' +
                'back to the pinned section when they close.'),
        });
        sectionGroup.add(switchRow(settings, 'running-section-enabled',
            _('Separate running apps from pinned apps'),
            _('Three sections with a separator between each: pinned apps, running apps, ' +
              'and storage / mounted drives / trash.')));
        running.add(sectionGroup);

        const sepGroup = new Adw.PreferencesGroup({title: _('Separator')});
        const sepVisible = switchRow(settings, 'separator-visible', _('Show separator line'));
        const sepThickness = spinRow(settings, 'separator-thickness', _('Thickness'), _('Pixels'), 1, 8);
        const sepLength = spinRow(settings, 'separator-length', _('Length'),
            _('Percent of the icon size'), 10, 150);
        const sepMode = comboRow(settings, 'separator-color-mode', _('Colour'), [
            ['auto', _('Automatic (matches style)')],
            ['custom', _('Custom')],
        ]);
        const sepColor = colorRow(settings, 'separator-color', _('Custom colour'));
        const sepOpacity = spinRow(settings, 'separator-opacity', _('Opacity'), _('Percent'), 0, 100);
        const sepRows = [sepVisible, sepThickness, sepLength, sepMode, sepColor, sepOpacity];
        for (const row of sepRows)
            sepGroup.add(row);
        dependOn(settings, 'running-section-enabled', sepRows);
        dependOn(settings, 'separator-visible',
            [sepThickness, sepLength, sepMode, sepColor, sepOpacity]);
        running.add(sepGroup);

        const compat = new Adw.PreferencesGroup({
            title: _('Compatibility'),
            description: _('Works alongside Dash to Dock, Ubuntu Dock and Flourish. ' +
                'Icons are only re-ordered, never re-created, scaled or clipped.'),
        });
        running.add(compat);
        window.add(running);

        // ---- Visibility -----------------------------------------------------
        const visibility = new Adw.PreferencesPage({
            title: _('Visibility'),
            icon_name: 'view-reveal-symbolic',
        });
        const hideGroup = new Adw.PreferencesGroup({
            title: _('Hide the dock'),
            description: _('Each option is independent. The dock fades out while the chosen ' +
                'view is open and comes back when you leave it.'),
        });
        hideGroup.add(switchRow(settings, 'hide-in-overview', _('In Activities Overview'),
            _('The window overview (Super key, hot corner or Activities button).')));
        hideGroup.add(switchRow(settings, 'hide-in-app-grid', _('In the app grid'),
            _('The Show Applications grid.')));
        visibility.add(hideGroup);
        window.add(visibility);

        // ---- Troubleshooting ----------------------------------------------
        const trouble = new Adw.PreferencesPage({
            title: _('Troubleshooting'),
            icon_name: 'dialog-information-symbolic',
        });
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debugging'),
            description: _('To find out which feature causes a glitch, turn features off one at a time: ' +
                'set all gaps to 0, turn off "Separate running apps", turn off "Override the dock ' +
                'background" and "Customize the border". To read the log, run: ' +
                'journalctl -f -o cat /usr/bin/gnome-shell'),
        });
        debugGroup.add(switchRow(settings, 'debug', _('Log debug messages')));
        trouble.add(debugGroup);
        window.add(trouble);
    }
}
