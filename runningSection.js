// SPDX-License-Identifier: GPL-2.0-or-later
//
// Splits the dock into a "pinned" section and a "running" section and puts a
// separator line between each pair of sections. Pinned apps move to the
// running section while they run and move back when they close.
//
// Compatibility notes (Dash to Dock / Ubuntu Dock / Flourish / other add-ons):
// - Icons are only re-ordered with set_child_at_index(), and only among the
//   slots icons already occupy. They are never re-parented, re-created,
//   scaled, translated or clipped.
// - The separators are plain widgets in the icon box with no margins, like the
//   stock separator. Their length follows the dock's icon size.
// - Before Dash to Dock re-syncs its icons we put the children back in the
//   order it expects, so it does not destroy and re-create "moved" icons.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {planLayout, slotOrder} from './layout.js';
import {scheduleBeforeRedraw} from './laters.js';

const SEPARATOR_NAME = 'dash-to-dock-tweaks-running-separator';

function appOf(actor) {
    return actor.child?.app ?? actor.child?._delegate?.app ?? null;
}

export class RunningSection {
    constructor(dash, log = () => {}) {
        this._log = log;
        this._settleId = 0;
        this._dash = dash;
        this._box = dash._box;
        this._cfg = null;
        this._separators = [];
        this._busy = false;
        this._gone = false;
        this._cancelLater = null;
        this._signals = [];

        const appSystem = Shell.AppSystem.get_default();
        const favorites = AppFavorites.getAppFavorites();
        this._connect(dash, 'destroy', () => {
            this._gone = true;
        });
        this._connect(this._box, 'child-added', () => this._queue());
        this._connect(this._box, 'child-removed', () => this._queue());
        // icon size changes -> separator length must follow
        this._connect(this._box, 'notify::allocation', () => this._queueSettle());
        this._connect(appSystem, 'app-state-changed', () => this._onChange());
        this._connect(appSystem, 'installed-changed', () => this._onChange());
        this._connect(favorites, 'changed', () => this._onChange());
        this._log('running section attached');
    }

    get dash() {
        return this._dash;
    }

    get gone() {
        return this._gone;
    }

    update(cfg) {
        this._cfg = cfg;
        this._apply();
    }

    destroy(gone = false) {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = 0;
        }
        this._log('running section detached');
        this._cancelLater?.();
        this._cancelLater = null;
        for (const [obj, id] of this._signals) {
            if (gone && (obj === this._box || obj === this._dash))
                continue;
            obj.disconnect(id);
        }
        this._signals = [];

        if (!gone && !this._gone) {
            this._detachSeparators();
            this._canonicalize();
            if (this._dash._separator)
                this._dash._separator.visible = true;
        }
        for (const sep of this._separators) {
            try {
                sep.destroy();
            } catch (e) {
                // already destroyed together with the dock
            }
        }
        this._separators = [];
        this._dash = null;
        this._box = null;
    }

    // --- internals ---------------------------------------------------------

    _connect(obj, signal, callback) {
        this._signals.push([obj, obj.connect(signal, callback)]);
    }

    _queue() {
        if (this._busy || this._cancelLater || this._gone)
            return;
        this._cancelLater = scheduleBeforeRedraw(() => {
            this._cancelLater = null;
            this._apply();
        });
    }

    // The dash resizes on every frame while the dock slides; wait for it to settle.
    _queueSettle() {
        if (this._gone || this._busy)
            return;
        if (this._settleId)
            GLib.Source.remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._settleId = 0;
            this._queue();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Dash to Dock queues its own re-sync on these signals. Put the icons
    // back in its expected order right now (its work runs later), then
    // re-apply our layout once it has finished.
    _onChange() {
        if (this._gone)
            return;
        this._canonicalize();
        this._queue();
    }

    _entries() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const running = Shell.AppSystem.get_default().get_running();
        const entries = [];
        for (const child of this._box.get_children()) {
            // Icons that are fading out keep their slot until they are gone.
            const app = child.animatingOut ? null : appOf(child);
            if (!app)
                continue;
            entries.push({
                id: app.get_id(),
                running: app.state === Shell.AppState.RUNNING,
                actor: child,
            });
        }
        return {
            entries,
            favIds: favorites.map(a => a.get_id()),
            runIds: running.map(a => a.get_id()),
        };
    }

    // Only the icons and our separators are re-ordered; any other child of
    // the box (added by another extension) keeps its slot.
    _place(desired) {
        const target = slotOrder(this._box.get_children(), desired);
        target.forEach((actor, i) => {
            if (this._box.get_child_at_index(i) !== actor)
                this._box.set_child_at_index(actor, i);
        });
    }

    _detachSeparators() {
        for (const sep of this._separators) {
            if (sep.get_parent() === this._box)
                this._box.remove_child(sep);
        }
    }

    // Keep exactly `count` separators attached to the box.
    _syncSeparators(count) {
        while (this._separators.length > count)
            this._separators.pop().destroy();
        while (this._separators.length < count) {
            this._separators.push(new St.Widget({
                name: SEPARATOR_NAME,
                reactive: false,
                can_focus: false,
                track_hover: false,
            }));
        }
        for (const sep of this._separators) {
            if (!sep.get_parent())
                this._box.add_child(sep);
        }
    }

    _canonicalize() {
        if (!this._box || this._dash._dragPlaceholder)
            return;
        this._busy = true;
        try {
            // Our separators stay attached (Dash to Dock ignores bare widgets);
            // detaching and re-adding them would make the dock blink.
            const {entries, favIds, runIds} = this._entries();
            const plan = planLayout(entries, favIds, runIds);
            this._place(plan.canonical.map(e => e.actor));
        } finally {
            this._busy = false;
        }
    }

    _apply() {
        const cfg = this._cfg;
        if (!cfg || this._gone || !this._box)
            return;
        if (!cfg.enabled) {
            this._busy = true;
            try {
                this._detachSeparators();
            } finally {
                this._busy = false;
            }
            this._canonicalize();
            if (this._dash._separator)
                this._dash._separator.visible = true;
            return;
        }
        // Leave Dash to Dock alone while the user is dragging an icon.
        if (this._dash._dragPlaceholder)
            return;

        this._busy = true;
        try {
            // Our separators replace the stock one (which only separates
            // pinned from non-pinned apps).
            if (this._dash._separator)
                this._dash._separator.visible = false;

            const {entries, favIds, runIds} = this._entries();
            const plan = planLayout(entries, favIds, runIds);

            // A separator between every pair of neighbouring sections:
            // pinned | running | storage, mounted drives and trash.
            const count = cfg.separator.visible ? plan.sections.length - 1 : 0;
            if (count > 0)
                this._syncSeparators(count);
            else
                this._detachSeparators();

            const length = this._separatorLength(plan, cfg.separator);
            const shift = this._centreShift(plan);
            const ordered = [];
            plan.sections.forEach((group, i) => {
                if (i > 0 && count > 0) {
                    const sep = this._separators[i - 1];
                    this._styleSeparator(sep, cfg.separator, length, shift);
                    ordered.push(sep);
                }
                ordered.push(...group.map(e => e.actor));
            });
            this._place(ordered);
        } finally {
            this._busy = false;
        }
    }

    _isVertical() {
        return this._box.orientation !== undefined
            ? this._box.orientation === Clutter.Orientation.VERTICAL
            : !!this._box.vertical;
    }

    // Length of the line as a percentage of the icon size.
    _separatorLength(plan, {length}) {
        const ref = plan.sections[0]?.[0]?.actor;
        let size = this._dash.iconSize;
        if (!size)
            size = ref ? (this._isVertical() ? ref.width : ref.height) : 48;
        return Math.max(2, Math.round(size * length / 100));
    }

    // How far the icons' visual centre is from the centre of the icon box.
    //
    // Dash to Dock pads the icon buttons more on the side facing the screen
    // edge (and this extension adds the gap there), so the icons, and the dock
    // background around them, sit off-centre inside the box. Reading the real
    // padding of an icon button makes the line follow the dock whenever the
    // gap, the dock position or the dock style changes.
    _centreShift(plan) {
        const button = plan.sections[0]?.[0]?.actor?.child;
        if (!button?.get_theme_node)
            return 0;
        const node = button.get_theme_node();
        const [start, end] = this._isVertical()
            ? [St.Side.LEFT, St.Side.RIGHT]
            : [St.Side.TOP, St.Side.BOTTOM];
        return Math.round((node.get_padding(start) - node.get_padding(end)) / 2);
    }

    // No margins: the line is centred on the icons and sized from the icon
    // size. The shift is a transform, so it never changes the layout.
    _styleSeparator(sep, {thickness, css}, length, shift) {
        sep.set_style(css);
        const vertical = this._isVertical();
        const [w, h] = vertical ? [length, thickness] : [thickness, length];
        if (sep.width !== w || sep.height !== h)
            sep.set_size(w, h);
        sep.set({
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const [tx, ty] = vertical ? [shift, 0] : [0, shift];
        if (sep.translation_x !== tx || sep.translation_y !== ty)
            sep.set_translation(tx, ty, 0);
    }
}
