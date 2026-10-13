// SPDX-License-Identifier: GPL-2.0-or-later
//
// Dash to Dock Tweaks - add-on for Dash to Dock / Ubuntu Dock.
// Adds per-edge gaps, a light/dark/system background, a custom border and a
// separate running-apps section.
//
// Gaps follow Dash to Dock's own stylesheet: on the side facing the screen edge
// the dock background gets a margin and every icon button gets the same amount
// of extra padding. The padding is part of the icons' layout, so the dock
// itself grows, and the gap stays inside the dock's hover box, barrier and
// struts (autohide / intelligent hide keep working). A margin on the
// background alone only shrinks the background over the icons.
//
// It never imports code from the dock extension and it undoes everything in
// disable().

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RunningSection} from './runningSection.js';
import {StyleSlot} from './styleSlot.js';
import {scheduleBeforeRedraw} from './laters.js';

// If a future Dash to Dock release renames these, adjust here only.
const DOCK_ACTOR_NAME = 'dashtodockContainer';
const BACKGROUND_STYLE_CLASS = 'dash-background';
const BOX_ACTOR_NAME = 'dashtodockBox'; // hover box; add-ons such as Dynamic Music Pill live in it

function parseRgb(value, fallback) {
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(value ?? '');
    return m ? m.slice(1, 4).map(n => Math.min(255, Number(n))) : fallback;
}

function findByStyleClass(actor, styleClass) {
    for (const child of actor.get_children()) {
        if (child instanceof St.Widget && child.has_style_class_name(styleClass))
            return child;
        const found = findByStyleClass(child, styleClass);
        if (found)
            return found;
    }
    return null;
}

const SIDES = {
    top: St.Side.TOP,
    right: St.Side.RIGHT,
    bottom: St.Side.BOTTOM,
    left: St.Side.LEFT,
};
// Dash to Dock styles these as the dock's icon buttons.
const ITEM_STYLE_CLASSES = ['app-well-app', 'show-apps', 'overview-tile'];

function dockSide(actor) {
    return Object.keys(SIDES).find(name => actor.has_style_class_name(name)) ?? null;
}

function findByName(actor, name) {
    for (const child of actor.get_children()) {
        if (child.name === name)
            return child;
        const found = findByName(child, name);
        if (found)
            return found;
    }
    return null;
}

// Position of `actor`'s top-left corner in `ancestor`'s coordinates, from layout
// allocations only (so animations and other transforms do not matter).
function offsetIn(ancestor, actor) {
    let x = 0;
    let y = 0;
    for (let a = actor; a !== ancestor; a = a.get_parent()) {
        if (!a)
            return null;
        const box = a.get_allocation_box();
        x += box.x1;
        y += box.y1;
    }
    return {x, y};
}

function collectItems(actor, found = []) {
    for (const child of actor.get_children()) {
        if (child instanceof St.Widget &&
            ITEM_STYLE_CLASSES.some(c => child.has_style_class_name(c)))
            found.push(child);
        collectItems(child, found);
    }
    return found;
}

function collectIcons(actor, found = []) {
    for (const child of actor.get_children()) {
        if (child instanceof St.Icon)
            found.push(child);
        collectIcons(child, found);
    }
    return found;
}

// The dock's dash is a JS object (DockDash) that is itself an actor in the
// dock container. Match it by shape rather than by name.
function findDash(actor) {
    for (const child of actor.get_children()) {
        if (child._box instanceof St.BoxLayout && typeof child._redisplay === 'function')
            return child;
        const found = findDash(child);
        if (found)
            return found;
    }
    return null;
}

/** Decorates one dock actor (one per monitor). */
class DockTweak {
    constructor(actor, owner) {
        this._actor = actor;
        this._owner = owner;
        this._background = new StyleSlot(() => owner.queueUpdate());
        this._foreground = new Map(); // actor -> StyleSlot
        this._hidden = false;
        this._gap = new Map(); // actor -> {slot, native}
        this._gapKey = '';
        this._followEnabled = false;
        this._hoverBox = null;
        this._hoverSignal = 0;
        this._following = false;
        this._followers = new Map(); // child -> {last, ours, ids}
        this._followTimer = 0;
        this._watchedBox = null;
        this._boxSignal = 0;
        this._section = null;
        this._destroySignal = actor.connect('destroy', () => owner.untrack(actor));
    }

    apply(cfg) {
        if (!this._actor)
            return;
        this._applyBackground(cfg.css);
        this._applyGap(cfg.gap);
        this._applyFollow(cfg.followWidgets);
        this._applyForeground(cfg.foregroundCss);
        this._applySection(cfg.running);
        this._applyHidden(cfg.hidden);
    }

    destroy(actorGone = false) {
        if (!this._actor)
            return;
        if (!actorGone) {
            this._actor.disconnect(this._destroySignal);
            if (this._hidden) {
                this._hidden = false;
                this._actor.remove_transition('opacity');
                this._actor.opacity = 255;
                this._actor.remove_clip();
            }
        }
        this._section?.destroy(actorGone);
        this._section = null;
        this._background.release(!actorGone);
        for (const slot of this._foreground.values())
            slot.release(!actorGone);
        this._foreground.clear();
        this._releaseGap(!actorGone);
        this._unwatchBox();
        this._stopFollowing(!actorGone);
        this._unwatchHoverBox();
        this._actor = null;
        this._owner = null;
    }

    // --- pinned / running sections ---------------------------------------

    _applySection(running) {
        const dash = running.enabled ? findDash(this._actor) : null;
        if (this._section &&
            (!dash || this._section.dash !== dash || this._section.gone)) {
            this._section.destroy(this._section.gone);
            this._section = null;
        }
        if (!dash)
            return;
        if (!this._section)
            this._section = new RunningSection(dash, msg => this._owner?.debug(msg));
        this._section.update(running);
    }

    // --- gaps / background / border --------------------------------------

    _applyBackground(css) {
        this._background.attach(findByStyleClass(this._actor, BACKGROUND_STYLE_CLASS));
        this._background.set(css);
    }

    // --- hide in Activities Overview / app grid ----------------------------
    //
    // The dock is faded out and clipped away; its `visible` property is never
    // touched. The Shell and Dash to Dock own that property (fullscreen apps,
    // workspace switches, autohide), and fighting over it could leave the dock
    // stuck hidden.

    _applyHidden(hidden) {
        if (hidden === this._hidden)
            return;
        this._hidden = hidden;
        this._owner?.debug(hidden ? 'hiding dock (overview)' : 'showing dock (overview)');
        const actor = this._actor;
        actor.remove_transition('opacity');
        if (hidden) {
            actor.ease({
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    // an empty clip also stops the invisible dock taking clicks
                    if (this._hidden && this._actor)
                        this._actor.set_clip(0, 0, 0, 0);
                },
            });
        } else {
            actor.remove_clip();
            actor.ease({
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    // --- gap to the screen edge --------------------------------------------

    _applyGap(gaps) {
        const actor = this._actor;
        const side = dockSide(actor);
        // Dash to Dock restyles itself when its mode changes (shrink, extended,
        // fixed, position): then start over so the native values are re-read.
        const key = `${side}|${actor.style_class}`;
        if (key !== this._gapKey) {
            this._releaseGap(true);
            this._gapKey = key;
        }
        this._watchBox();

        const bg = findByStyleClass(actor, BACKGROUND_STYLE_CLASS);
        if (!gaps || !side || !bg) {
            this._releaseGap(true);
            return;
        }
        const gap = gaps[side];
        const edge = SIDES[side];

        // drop entries whose actors are gone
        for (const [a, entry] of this._gap) {
            if (!entry.slot.actor) {
                entry.slot.release(false);
                this._gap.delete(a);
            }
        }

        const entryFor = (target, read) => {
            let entry = this._gap.get(target);
            if (!entry) {
                const slot = new StyleSlot(() => this._owner?.queueUpdate());
                slot.attach(target);
                // Read Dash to Dock's own value before we add anything.
                entry = {slot, native: read(target.get_theme_node())};
                this._gap.set(target, entry);
            }
            return entry;
        };

        const bgEntry = entryFor(bg, node => (node.get_margin ? node.get_margin(edge) : 4));
        bgEntry.slot.set(`margin-${side}: ${gap}px;`);

        const delta = gap - bgEntry.native;
        for (const item of collectItems(actor)) {
            const entry = entryFor(item, node => node.get_padding(edge));
            entry.slot.set(`padding-${side}: ${Math.max(0, Math.round(entry.native + delta))}px;`);
        }
        // The icons just moved: re-measure the add-ons' widgets once laid out.
        this._queueFollow();
    }

    // --- other add-ons' widgets inside the dock ---------------------------
    //
    // Dynamic Music Pill (and similar) put a widget in the dock's hover box,
    // next to the dash. Where it ends up across the dock depends on that box,
    // which the gap makes taller on the screen-edge side only, while the dock
    // background and the icons sit inside it. So the widget is centred on the
    // box, not on the icons. We measure both centres from the layout and add a
    // small transform that centres the widget on the app icons. It is applied
    // on top of whatever the add-on does itself (its own offsets still work).

    _applyFollow(enabled) {
        this._followEnabled = enabled;
        this._watchHoverBox();
        this._followNow();
    }

    _watchHoverBox() {
        const box = findByName(this._actor, BOX_ACTOR_NAME);
        if (box === this._hoverBox)
            return;
        this._unwatchHoverBox();
        if (!box)
            return;
        this._hoverBox = box;
        // an add-on adds its widget (e.g. at login): align it when it appears
        this._hoverSignal = box.connect('child-added', () => this._queueFollow());
    }

    _unwatchHoverBox() {
        if (this._hoverBox && this._hoverSignal)
            this._hoverBox.disconnect(this._hoverSignal);
        this._hoverBox = null;
        this._hoverSignal = 0;
    }

    _foreignChildren() {
        const box = findByName(this._actor, BOX_ACTOR_NAME);
        const dash = findDash(this._actor);
        if (!box || !dash)
            return [];
        return box.get_children().filter(c => c !== dash && !c.contains(dash));
    }

    // Transform that puts `child`'s centre on the centre of the app icons
    // (across the dock), or null if it cannot be measured yet.
    _alignment(child) {
        const side = dockSide(this._actor);
        const box = findByName(this._actor, BOX_ACTOR_NAME);
        const items = collectItems(this._actor);
        const ref = items.find(a => a.has_style_class_name('app-well-app')) ?? items[0];
        if (!side || !box || !ref)
            return null;
        const vertical = side === 'left' || side === 'right';
        const at = offsetIn(box, ref);
        if (!at)
            return null;

        const alloc = ref.get_allocation_box();
        const node = ref.get_theme_node();
        const [start, end] = vertical ? [St.Side.LEFT, St.Side.RIGHT] : [St.Side.TOP, St.Side.BOTTOM];
        const size = vertical ? alloc.get_width() : alloc.get_height();
        // centre of the icon inside its (unevenly padded) button
        const iconCentre = (vertical ? at.x : at.y) + size / 2 +
            (node.get_padding(start) - node.get_padding(end)) / 2;

        const own = child.get_allocation_box();
        const widgetCentre = vertical ? (own.x1 + own.x2) / 2 : (own.y1 + own.y2) / 2;
        if (!size || !own.get_width() || !own.get_height())
            return null;

        const delta = Math.round(iconCentre - widgetCentre);
        return vertical ? {x: delta, y: 0} : {x: 0, y: delta};
    }

    _followNow() {
        const children = this._followEnabled ? this._foreignChildren() : [];

        for (const [child, st] of this._followers) {
            if (!children.includes(child))
                this._unfollow(child, st, true);
        }
        for (const child of children) {
            const want = this._alignment(child) ?? {x: 0, y: 0};
            let st = this._followers.get(child);
            if (!st) {
                if (!want.x && !want.y)
                    continue;
                st = {last: null, ours: {x: 0, y: 0}, ids: []};
                const changed = () => {
                    if (!this._following)
                        this._queueFollow();
                };
                st.ids.push(
                    child.connect('notify::translation-x', changed),
                    child.connect('notify::translation-y', changed),
                    child.connect('notify::allocation', changed),
                    child.connect('destroy', () => this._followers.delete(child)));
                this._followers.set(child, st);
                this._owner?.debug('aligning a widget inside the dock with the icons');
            }
            // If the add-on rewrote the translation since we last set it, our
            // part is gone: take its value as the new base.
            const unchanged = st.last &&
                child.translation_x === st.last.x && child.translation_y === st.last.y;
            const base = {
                x: unchanged ? child.translation_x - st.ours.x : child.translation_x,
                y: unchanged ? child.translation_y - st.ours.y : child.translation_y,
            };
            const next = {x: base.x + want.x, y: base.y + want.y};
            if (next.x === child.translation_x && next.y === child.translation_y) {
                st.last = next;
                st.ours = {...want};
                continue;
            }
            this._following = true;
            child.translation_x = next.x;
            child.translation_y = next.y;
            this._following = false;
            st.last = next;
            st.ours = {...want};
        }
    }

    // The add-on moved its widget (animation, offset change...): wait until it
    // is done, then put our part back.
    _queueFollow() {
        if (this._followTimer)
            GLib.Source.remove(this._followTimer);
        this._followTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._followTimer = 0;
            if (this._actor)
                this._followNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _unfollow(child, st, alive) {
        this._followers.delete(child);
        if (!alive)
            return;
        for (const id of st.ids)
            child.disconnect(id);
        if (st.last && child.translation_x === st.last.x && child.translation_y === st.last.y) {
            child.translation_x -= st.ours.x;
            child.translation_y -= st.ours.y;
        }
    }

    _stopFollowing(restore) {
        if (this._followTimer) {
            GLib.Source.remove(this._followTimer);
            this._followTimer = 0;
        }
        for (const [child, st] of [...this._followers])
            this._unfollow(child, st, restore);
        this._followers.clear();
    }

    _releaseGap(restore) {
        for (const entry of this._gap.values())
            entry.slot.release(restore);
        this._gap.clear();
    }

    // New icons appear when apps start; give them the gap padding before the
    // next frame so they do not pop in at the wrong size.
    _watchBox() {
        const box = findDash(this._actor)?._box ?? null;
        if (box === this._watchedBox)
            return;
        this._unwatchBox();
        if (!box)
            return;
        this._watchedBox = box;
        this._boxSignal = box.connect('child-added', () => this._owner?.queueUpdate(true));
    }

    _unwatchBox() {
        if (this._watchedBox && this._boxSignal)
            this._watchedBox.disconnect(this._boxSignal);
        this._watchedBox = null;
        this._boxSignal = 0;
    }

    // --- foreground (icon colour of the Show Applications button) ---------

    _applyForeground(css) {
        const targets = new Set();
        const showApps = css ? findDash(this._actor)?._showAppsIcon : null;
        if (showApps) {
            targets.add(showApps);
            for (const icon of collectIcons(showApps))
                targets.add(icon);
        }
        for (const [actor, slot] of this._foreground) {
            if (!targets.has(actor) || slot.actor !== actor) {
                slot.release(slot.actor === actor);
                this._foreground.delete(actor);
            }
        }
        for (const actor of targets) {
            let slot = this._foreground.get(actor);
            if (!slot) {
                slot = new StyleSlot(() => this._owner?.queueUpdate());
                this._foreground.set(actor, slot);
            }
            slot.attach(actor);
            slot.set(css);
        }
    }
}

export default class DashToDockTweaks extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._tweaks = new Map();
        this._signals = [];
        this._updateId = 0;
        this._startId = 0;
        this._cancelLater = null;
        this._active = false;

        this._connect(this._settings, 'changed', () => this.queueUpdate());
        this._connect(this._interface, 'changed::color-scheme', () => this.queueUpdate());
        this._connect(Main.layoutManager.uiGroup, 'child-added',
            (_group, actor) => this._maybeTrack(actor));
        this._overviewClosing = false;
        for (const name of ['showing', 'shown', 'hiding', 'hidden']) {
            this._connect(Main.overview, name, () => {
                this._overviewClosing = name === 'hiding';
                this.queueUpdate(true);
            });
        }
        const showApps = Main.overview.dash?.showAppsButton;
        if (showApps)
            this._connect(showApps, 'notify::checked', () => this.queueUpdate(true));
        this._connect(Main.extensionManager, 'extension-state-changed', () => {
            if (this._active)
                this._scan();
        });

        // At login the Shell and Dash to Dock are still running their startup
        // animation. Touching the dock then can leave it stuck off-screen, so
        // wait until startup is over and the dock has settled.
        if (Main.layoutManager._startingUp) {
            this.debug('waiting for shell startup to finish');
            this._connect(Main.layoutManager, 'startup-complete', () => this._startSoon(1500));
        } else {
            this._startSoon(0);
        }
    }

    disable() {
        for (const key of ['_updateId', '_startId']) {
            if (this[key]) {
                GLib.Source.remove(this[key]);
                this[key] = 0;
            }
        }
        this._active = false;
        this._cancelLater?.();
        this._cancelLater = null;
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];

        for (const tweak of this._tweaks.values())
            tweak.destroy();
        this._tweaks.clear();
        this._tweaks = null;

        this._interface = null;
        this._settings = null;
    }

    // --- public to DockTweak ---------------------------------------------

    debug(message) {
        if (this._settings?.get_boolean('debug'))
            console.log(`[dash-to-dock-tweaks] ${message}`);
    }

    // `beforeRedraw`: apply before the next frame instead of when idle.
    queueUpdate(beforeRedraw = false) {
        if (!this._active)
            return;
        if (beforeRedraw) {
            if (this._cancelLater)
                return;
            this._cancelLater = scheduleBeforeRedraw(() => {
                this._cancelLater = null;
                this._applyAll();
            });
            return;
        }
        if (this._updateId)
            return;
        this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._updateId = 0;
            this._applyAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    untrack(actor) {
        const tweak = this._tweaks?.get(actor);
        if (!tweak)
            return;
        this._tweaks.delete(actor);
        tweak.destroy(true);
    }

    // --- internals ---------------------------------------------------------

    _connect(obj, signal, callback) {
        this._signals.push([obj, obj.connect(signal, callback)]);
    }

    _startSoon(delayMs) {
        if (this._startId || this._active)
            return;
        const start = () => {
            this._startId = 0;
            this._active = true;
            this.debug('started');
            this._scan();
            this.queueUpdate();
            return GLib.SOURCE_REMOVE;
        };
        if (delayMs > 0)
            this._startId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, start);
        else
            start();
    }

    _scan() {
        for (const child of Main.layoutManager.uiGroup.get_children())
            this._maybeTrack(child);
    }

    _maybeTrack(actor) {
        if (!this._active || !this._tweaks || actor.name !== DOCK_ACTOR_NAME ||
            this._tweaks.has(actor))
            return;
        this.debug('dock found');
        this._tweaks.set(actor, new DockTweak(actor, this));
        this.queueUpdate();
    }

    // 'none' | 'activities' (window overview) | 'appgrid'
    _overviewState() {
        if (!Main.overview.visible || this._overviewClosing)
            return 'none';
        return Main.overview.dash?.showAppsButton?.checked ? 'appgrid' : 'activities';
    }

    _isDark() {
        const mode = this._settings.get_string('style-mode');
        if (mode === 'system')
            return this._interface.get_string('color-scheme') === 'prefer-dark';
        return mode === 'dark';
    }

    _buildConfig() {
        const s = this._settings;
        const dark = this._isDark();
        const decl = [];

        const gap = s.get_boolean('gaps-enabled') ? {
            top: s.get_int('gap-top'),
            right: s.get_int('gap-right'),
            bottom: s.get_int('gap-bottom'),
            left: s.get_int('gap-left'),
        } : null;

        if (s.get_boolean('manage-background')) {
            const [r, g, b] = parseRgb(
                s.get_string(dark ? 'dark-color' : 'light-color'),
                dark ? [36, 36, 36] : [242, 242, 242]);
            const alpha = (s.get_int('background-opacity') / 100).toFixed(2);
            decl.push(`background-color: rgba(${r},${g},${b},${alpha});`);
        }

        if (s.get_boolean('border-enabled')) {
            const alpha = (s.get_int('border-opacity') / 100).toFixed(2);
            let rgb;
            if (s.get_string('border-color-mode') === 'custom')
                rgb = parseRgb(s.get_string('border-color'), [128, 128, 128]);
            else
                rgb = dark ? [255, 255, 255] : [0, 0, 0];
            decl.push(`border-width: ${s.get_int('border-width')}px;`);
            decl.push(`border-color: rgba(${rgb.join(',')},${alpha});`);
        }

        if (s.get_boolean('override-radius'))
            decl.push(`border-radius: ${s.get_int('border-radius')}px;`);

        let foregroundCss = '';
        if (s.get_boolean('manage-foreground')) {
            const [fr, fg, fb] = s.get_string('foreground-mode') === 'custom'
                ? parseRgb(s.get_string('foreground-color'), [36, 36, 36])
                : (dark ? [255, 255, 255] : [36, 36, 36]);
            foregroundCss = `color: rgb(${fr},${fg},${fb});`;
        }

        const sepAlpha = (s.get_int('separator-opacity') / 100).toFixed(2);
        const sepRgb = s.get_string('separator-color-mode') === 'custom'
            ? parseRgb(s.get_string('separator-color'), [128, 128, 128])
            : (dark ? [255, 255, 255] : [0, 0, 0]);
        const sepThickness = s.get_int('separator-thickness');

        const overview = this._overviewState();
        const hidden =
            (overview === 'activities' && s.get_boolean('hide-in-overview')) ||
            (overview === 'appgrid' && s.get_boolean('hide-in-app-grid'));

        return {
            followWidgets: s.get_boolean('follow-dock-widgets'),
            hidden,
            running: {
                enabled: s.get_boolean('running-section-enabled'),
                separator: {
                    visible: s.get_boolean('separator-visible'),
                    thickness: sepThickness,
                    length: s.get_int('separator-length'),
                    css: `background-color: rgba(${sepRgb.join(',')},${sepAlpha}); ` +
                        `border-radius: ${sepThickness / 2}px;`,
                },
            },
            css: decl.join(' '),
            gap,
            foregroundCss,
        };
    }

    _applyAll() {
        if (!this._tweaks)
            return;
        const cfg = this._buildConfig();
        for (const tweak of this._tweaks.values())
            tweak.apply(cfg);
    }
}
