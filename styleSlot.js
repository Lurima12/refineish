// SPDX-License-Identifier: GPL-2.0-or-later
//
// Adds our CSS declarations to an actor's inline style without clobbering
// whatever the dock extension put there, and removes them again on release.

export class StyleSlot {
    constructor(onExternalChange) {
        this._onExternalChange = onExternalChange;
        this._actor = null;
        this._ours = '';
        this._styleSignal = 0;
        this._destroySignal = 0;
    }

    get actor() {
        return this._actor;
    }

    attach(actor) {
        if (actor === this._actor)
            return;
        this.release(true);
        this._actor = actor;
        this._ours = '';
        if (!actor)
            return;
        this._styleSignal = actor.connect('notify::style', () => this._onExternalChange());
        this._destroySignal = actor.connect('destroy', () => {
            this._actor = null;
            this._styleSignal = 0;
            this._destroySignal = 0;
        });
    }

    set(css) {
        const actor = this._actor;
        if (!actor)
            return;
        const current = actor.get_style() ?? '';
        let base = this._ours ? current.split(this._ours).join('') : current;
        base = base.trim();
        if (base && !base.endsWith(';'))
            base += ';';
        const ours = css ? ` ${css}` : '';
        const next = `${base}${ours}`;
        this._ours = ours;
        if (next !== current)
            actor.set_style(next || null);
    }

    release(restore) {
        const actor = this._actor;
        if (!actor)
            return;
        if (restore)
            this.set('');
        if (this._styleSignal)
            actor.disconnect(this._styleSignal);
        if (this._destroySignal)
            actor.disconnect(this._destroySignal);
        this._actor = null;
        this._styleSignal = 0;
        this._destroySignal = 0;
        this._ours = '';
    }
}
