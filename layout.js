// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure ordering logic for the pinned / running sections. It has no GNOME
// imports so it can be tested with plain Node.

/**
 * @param {{id: string, running: boolean}[]} entries  dock icons, any order
 * @param {string[]} favIds   pinned app ids, in pinned order
 * @param {string[]} runIds   running app ids, in launch order
 * @returns canonical: the order Dash to Dock itself expects
 *          pinnedStopped / running / tail: the three groups of our layout
 *          sections: the non-empty groups, in display order (a separator
 *          goes between each pair of neighbours)
 */
export function planLayout(entries, favIds, runIds) {
    const rankOf = id => {
        let i = favIds.indexOf(id);
        if (i >= 0)
            return i;
        i = runIds.indexOf(id);
        return i >= 0 ? favIds.length + i : -1;
    };

    const ranked = entries
        .map(entry => ({entry, rank: rankOf(entry.id)}))
        .filter(r => r.rank >= 0)
        .sort((a, b) => a.rank - b.rank);
    const tail = entries.filter(entry => rankOf(entry.id) < 0);

    const pinnedStopped = [];
    const running = [];
    for (const {entry, rank} of ranked) {
        const pinned = rank < favIds.length;
        (pinned && !entry.running ? pinnedStopped : running).push(entry);
    }

    return {
        canonical: [...ranked.map(r => r.entry), ...tail],
        pinnedStopped,
        running,
        tail,
        sections: [pinnedStopped, running, tail].filter(g => g.length > 0),
    };
}

/**
 * Re-order `desired` while every other child keeps its exact slot. This lets
 * widgets that other extensions put in the dock (e.g. a music pill that
 * positions itself by index) stay where they are.
 *
 * @param {any[]} children  current children of the box, in order
 * @param {any[]} desired   the children we manage, in the order we want
 * @returns the full target order of `children`
 */
export function slotOrder(children, desired) {
    const wanted = new Set(desired);
    let k = 0;
    return children.map(child => (wanted.has(child) ? desired[k++] : child));
}
