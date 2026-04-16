/**
 * playerSelector.js — Multi-instance player selection
 *
 * Exposes a top-right pill button (mirrors the provider / audio-source
 * selectors) that lists players served by the backend PlayerManager.
 * The current selection drives the `?player=` query param that /current-track
 * and /lyrics already honor.
 *
 * Selection precedence, highest first:
 *   1. `?player=<name>` URL parameter (wins — intended for kiosks where
 *      on-screen buttons can't be tapped; also pins the selector)
 *   2. localStorage `selectedPlayer`
 *   3. null (auto / fallback — server picks a live player)
 *
 * Level 2 — Imports: dom (toast)
 */

import { showToast } from './dom.js';
import { setSelectedPlayer } from './state.js';

const STORAGE_KEY = 'selectedPlayer';
const URL_LOCK_FLAG = Symbol('url-locked');

let state = {
    selected: null,         // player name or null (auto)
    urlLocked: false,       // true when selection came from URL param
    players: [],            // last known list from /api/players
    multiInstanceActive: false,
    currentTrackPlayer: null, // player name observed in latest /current-track
};

// ========== URL & STORAGE ==========

function readUrlPlayer() {
    try {
        const params = new URLSearchParams(window.location.search);
        const raw = params.get('player');
        if (raw === null) return null;
        const trimmed = raw.trim();
        return trimmed || null;
    } catch (err) {
        return null;
    }
}

function readStoredPlayer() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored && stored.trim() ? stored.trim() : null;
    } catch (err) {
        return null;
    }
}

function persistSelection(name) {
    try {
        if (name) {
            localStorage.setItem(STORAGE_KEY, name);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch (err) {
        // localStorage unavailable (private mode etc.) — ignore
    }
}

// ========== PUBLIC ACCESSORS ==========

export function getSelectedPlayer() {
    return state.selected;
}

export function isUrlLocked() {
    return state.urlLocked;
}

/**
 * Register the player name the backend reported on /current-track. When no
 * explicit player has been chosen, this lets the badge display what the
 * server is actually sourcing from.
 */
export function recordCurrentTrackPlayer(name) {
    if (!name) return;
    if (name === state.currentTrackPlayer) return;
    state.currentTrackPlayer = name;
    if (!state.selected) {
        updatePlayerDisplay();
    }
}

// ========== RENDERING ==========

function effectivePlayerName() {
    return state.selected || state.currentTrackPlayer || null;
}

function updatePlayerDisplay() {
    const toggle = document.getElementById('player-toggle');
    const nameEl = document.getElementById('player-name');
    if (!toggle || !nameEl) return;

    if (!state.multiInstanceActive && state.players.length <= 1) {
        // Single-player (legacy) mode — keep the button hidden.
        toggle.classList.add('hidden');
        return;
    }

    toggle.classList.remove('hidden');
    toggle.classList.toggle('pinned', !!state.selected);

    const label = effectivePlayerName() || 'Auto';
    nameEl.textContent = label;

    const tooltipParts = [];
    if (state.selected) {
        tooltipParts.push(`Pinned to ${state.selected}`);
    } else if (state.currentTrackPlayer) {
        tooltipParts.push(`Auto — currently ${state.currentTrackPlayer}`);
    } else {
        tooltipParts.push('Auto — server picks a live player');
    }
    if (state.urlLocked) {
        tooltipParts.push('Locked via ?player= URL param');
    }
    toggle.title = tooltipParts.join(' • ');
}

// ========== MODAL ==========

async function fetchPlayersPayload() {
    try {
        const response = await fetch('/api/players');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } catch (err) {
        console.error('[PlayerSelector] Failed to fetch /api/players:', err);
        return null;
    }
}

function renderUnassigned(streams) {
    const wrap = document.getElementById('player-unassigned');
    const list = document.getElementById('player-unassigned-list');
    if (!wrap || !list) return;
    list.innerHTML = '';

    const unassigned = (streams || []).filter(s => !s.player);
    if (unassigned.length === 0) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    unassigned.forEach(stream => {
        const li = document.createElement('li');
        const ssrc = stream.ssrc_hex || stream.ssrc || '—';
        li.textContent = `${stream.source_ip || '?'} · SSRC ${ssrc}`;
        list.appendChild(li);
    });
}

function renderPlayerList(payload) {
    const listEl = document.getElementById('player-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const engines = payload.engines || [];
    const engineByName = new Map();
    engines.forEach(e => engineByName.set(e.player_name, e));

    const players = payload.configured || [];
    state.players = players;
    state.multiInstanceActive = !!payload.multi_instance_active;

    // Synthetic "Auto" entry — lets users clear a pinned selection.
    const autoItem = document.createElement('div');
    autoItem.className = 'player-item' + (state.selected ? '' : ' current-player');
    autoItem.innerHTML = `
        <div class="player-item-content">
            <div class="player-item-header">
                <span class="player-item-name">Auto</span>
                ${state.selected ? '' : '<span class="player-current-badge">Selected</span>'}
            </div>
            <div class="player-item-meta">Let the server pick the first live player</div>
        </div>
        <button class="player-select-btn" data-player="">
            ${state.selected ? 'Use' : 'Selected'}
        </button>
    `;
    listEl.appendChild(autoItem);

    if (players.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'player-empty';
        empty.textContent = 'No players configured. Add players under the addon config to enable multi-instance mode.';
        listEl.appendChild(empty);
    } else {
        players.forEach(player => {
            const engine = engineByName.get(player.name);
            const isSelected = state.selected === player.name;
            const item = document.createElement('div');
            item.className = 'player-item' + (isSelected ? ' current-player' : '');

            const metaBits = [];
            if (player.description) metaBits.push(player.description);
            if (player.source_ip) metaBits.push(`IP ${player.source_ip}`);
            if (player.rtp_ssrc) metaBits.push(`SSRC ${player.rtp_ssrc}`);
            if (engine && engine.last_song) {
                const s = engine.last_song;
                const label = `${s.artist || '?'} — ${s.title || '?'}`;
                metaBits.push(`Playing: ${label}`);
            }

            const autoBadge = player.auto
                ? '<span class="player-auto-badge">Auto</span>'
                : '';
            const currentBadge = isSelected
                ? '<span class="player-current-badge">Selected</span>'
                : '';

            item.innerHTML = `
                <div class="player-item-content">
                    <div class="player-item-header">
                        <span class="player-item-name">${escapeHtml(player.name)}</span>
                        ${autoBadge}
                        ${currentBadge}
                    </div>
                    <div class="player-item-meta">${escapeHtml(metaBits.join(' · ') || 'No activity yet')}</div>
                </div>
                <button class="player-select-btn" data-player="${escapeAttr(player.name)}">
                    ${isSelected ? 'Selected' : 'Use'}
                </button>
            `;
            listEl.appendChild(item);
        });
    }

    renderUnassigned(payload.streams);
}

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}

export async function showPlayerModal() {
    const modal = document.getElementById('player-modal');
    if (!modal) return;

    const payload = await fetchPlayersPayload();
    if (!payload) {
        showToast('Could not load player list', 'error');
        return;
    }

    renderPlayerList(payload);
    updatePlayerDisplay();

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
}

export function hidePlayerModal() {
    const modal = document.getElementById('player-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
}

export function selectPlayer(name) {
    if (state.urlLocked) {
        showToast('Player locked via URL parameter', 'info');
        return;
    }

    const normalized = name && name.trim() ? name.trim() : null;
    state.selected = normalized;
    setSelectedPlayer(normalized);
    persistSelection(normalized);
    updatePlayerDisplay();
    hidePlayerModal();

    if (normalized) {
        showToast(`Showing lyrics for ${normalized}`);
    } else {
        showToast('Following auto-selected player');
    }
}

// ========== INITIALIZATION ==========

/**
 * Refresh state from /api/players (polled occasionally by main.js so newly
 * discovered players appear without a full reload).
 */
export async function refreshPlayers() {
    const payload = await fetchPlayersPayload();
    if (!payload) return;
    state.players = payload.configured || [];
    state.multiInstanceActive = !!payload.multi_instance_active;

    // Validate the pinned selection still exists; if not, fall back to auto
    // unless the selection came from the URL (which we leave alone).
    if (state.selected && !state.urlLocked) {
        const known = state.players.some(p => p.name === state.selected);
        if (!known) {
            state.selected = null;
            setSelectedPlayer(null);
            persistSelection(null);
        }
    }

    updatePlayerDisplay();
}

export function setupPlayerUI() {
    const urlPlayer = readUrlPlayer();
    if (urlPlayer) {
        state.selected = urlPlayer;
        state.urlLocked = true;
    } else {
        state.selected = readStoredPlayer();
    }
    setSelectedPlayer(state.selected);

    const toggle = document.getElementById('player-toggle');
    if (toggle) {
        toggle.addEventListener('click', showPlayerModal);
    }

    const closeBtn = document.getElementById('player-modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', hidePlayerModal);
    }

    const modal = document.getElementById('player-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) hidePlayerModal();
        });
    }

    const listEl = document.getElementById('player-list');
    if (listEl) {
        listEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.player-select-btn');
            if (!btn) return;
            const name = btn.getAttribute('data-player') || '';
            selectPlayer(name);
        });
    }

    // Kick off an initial refresh so the button reveals itself once the
    // backend reports multi-instance mode.
    refreshPlayers();
}
