// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

/**
 * Run `callback` once, right before the next frame is drawn.
 * @returns a function that cancels it
 */
export function scheduleBeforeRedraw(callback) {
    const run = () => {
        callback();
        return GLib.SOURCE_REMOVE;
    };
    const laters = global.compositor?.get_laters?.();
    if (laters) {
        const id = laters.add(Meta.LaterType.BEFORE_REDRAW, run);
        return () => laters.remove(id);
    }
    const id = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, run);
    return () => Meta.later_remove(id);
}
