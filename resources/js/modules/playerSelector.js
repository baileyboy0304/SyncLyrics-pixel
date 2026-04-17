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
    maPlayers: null,        // cached Music Assistant player list
    maConfigured: false,    // whether MA integration is configured
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

function displayNameFor(name) {
    if (!name) return null;
    const p = state.players.find(x => x.name === name);
    return (p && p.display_name) || name;
}

function updatePlayerDisplay() {
    const toggle = document.getElementById('player-toggle');
    const nameEl = document.getElementById('player-name');
    if (!toggle || !nameEl) return;

    if (!state.multiInstanceActive) {
        toggle.classList.add('hidden');
        return;
    }

    toggle.classList.remove('hidden');
    toggle.classList.toggle('pinned', !!state.selected);

    const effective = effectivePlayerName();
    nameEl.textContent = effective ? displayNameFor(effective) : 'Auto';

    const tooltipParts = [];
    if (state.selected) {
        tooltipParts.push(`Pinned to ${displayNameFor(state.selected)}`);
    } else if (state.currentTrackPlayer) {
        tooltipParts.push(`Auto — currently ${displayNameFor(state.currentTrackPlayer)}`);
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
        empty.textContent = 'No players detected yet. Start playing to a Music Assistant speaker — it will appear here automatically.';
        listEl.appendChild(empty);
    } else {
        players.forEach(player => {
            const engine = engineByName.get(player.name);
            const isSelected = state.selected === player.name;
            const displayName = player.display_name || player.name;
            const item = document.createElement('div');
            item.className = 'player-item' + (isSelected ? ' current-player' : '');
            item.dataset.playerName = player.name;

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
                        <span class="player-item-name">${escapeHtml(displayName)}</span>
                        ${autoBadge}
                        ${currentBadge}
                    </div>
                    <div class="player-item-meta">${escapeHtml(metaBits.join(' · ') || 'No activity yet')}</div>
                    <div class="player-rename-form hidden" data-rename-for="${escapeAttr(player.name)}">
                        <label class="player-rename-label">Music Assistant player</label>
                        <select class="player-rename-ma" data-rename-ma-for="${escapeAttr(player.name)}">
                            <option value="">Loading…</option>
                        </select>
                        <label class="player-rename-label">Display name</label>
                        <input type="text" class="player-rename-input"
                               data-rename-input-for="${escapeAttr(player.name)}"
                               value="${escapeAttr(displayName)}"
                               placeholder="e.g. Kitchen Speaker" />
                        <div class="player-rename-actions">
                            <button class="player-rename-cancel" data-rename-cancel="${escapeAttr(player.name)}">Cancel</button>
                            <button class="player-rename-save" data-rename-save="${escapeAttr(player.name)}">Save</button>
                        </div>
                    </div>
                </div>
                <div class="player-item-actions">
                    <button class="player-rename-btn" data-rename-player="${escapeAttr(player.name)}" title="Rename / link to Music Assistant">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="player-select-btn" data-player="${escapeAttr(player.name)}">
                        ${isSelected ? 'Selected' : 'Use'}
                    </button>
                </div>
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
        showToast(`Showing lyrics for ${displayNameFor(normalized)}`);
    } else {
        showToast('Following auto-selected player');
    }
}

// ========== RENAME ==========

async function fetchMaPlayers() {
    if (state.maPlayers !== null) return state.maPlayers;
    try {
        const resp = await fetch('/api/music-assistant/players');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        state.maConfigured = !!data.configured;
        state.maPlayers = Array.isArray(data.players) ? data.players : [];
        return state.maPlayers;
    } catch (err) {
        console.error('[PlayerSelector] Failed to fetch MA players:', err);
        state.maPlayers = [];
        state.maConfigured = false;
        return state.maPlayers;
    }
}

async function populateMaDropdown(selectEl, currentPlayer) {
    const players = await fetchMaPlayers();
    selectEl.innerHTML = '';

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = state.maConfigured
        ? '— not linked —'
        : '— Music Assistant not configured —';
    selectEl.appendChild(blank);

    const linkedId = currentPlayer && currentPlayer.music_assistant_player_id;
    players.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.player_id || p.id || '';
        opt.textContent = p.name || p.display_name || opt.value;
        if (linkedId && opt.value === linkedId) opt.selected = true;
        selectEl.appendChild(opt);
    });

    selectEl.disabled = !state.maConfigured;
}

async function openRenameForm(playerName) {
    const listEl = document.getElementById('player-list');
    if (!listEl) return;
    // Hide any other rename forms.
    listEl.querySelectorAll('.player-rename-form').forEach(f => f.classList.add('hidden'));

    const form = listEl.querySelector(`.player-rename-form[data-rename-for="${cssEscape(playerName)}"]`);
    if (!form) return;
    form.classList.remove('hidden');

    const select = form.querySelector('.player-rename-ma');
    const player = state.players.find(p => p.name === playerName);
    if (select) {
        select.innerHTML = '<option value="">Loading…</option>';
        await populateMaDropdown(select, player);
        // When user picks an MA entry, prefill the display-name input with that name.
        select.onchange = () => {
            const opt = select.options[select.selectedIndex];
            const input = form.querySelector('.player-rename-input');
            if (opt && opt.value && input && !input.dataset.edited) {
                input.value = opt.textContent;
            }
        };
    }
    const input = form.querySelector('.player-rename-input');
    if (input) {
        input.addEventListener('input', () => { input.dataset.edited = '1'; }, { once: true });
        input.focus();
        input.select();
    }
}

function closeRenameForm(playerName) {
    const listEl = document.getElementById('player-list');
    if (!listEl) return;
    const form = listEl.querySelector(`.player-rename-form[data-rename-for="${cssEscape(playerName)}"]`);
    if (form) form.classList.add('hidden');
}

async function saveRename(playerName) {
    const listEl = document.getElementById('player-list');
    if (!listEl) return;
    const form = listEl.querySelector(`.player-rename-form[data-rename-for="${cssEscape(playerName)}"]`);
    if (!form) return;

    const input = form.querySelector('.player-rename-input');
    const select = form.querySelector('.player-rename-ma');
    const displayName = input ? input.value.trim() : '';
    const maId = select ? select.value.trim() : '';

    if (!displayName) {
        showToast('Display name cannot be empty', 'error');
        return;
    }

    try {
        const resp = await fetch(`/api/players/${encodeURIComponent(playerName)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                display_name: displayName,
                music_assistant_player_id: maId || null,
            }),
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(errText || `HTTP ${resp.status}`);
        }
        showToast(`Renamed to ${displayName}`);
        await refreshPlayers();
        // Re-render the modal list so updated names appear immediately.
        const payload = await fetchPlayersPayload();
        if (payload) renderPlayerList(payload);
    } catch (err) {
        console.error('[PlayerSelector] Rename failed:', err);
        showToast('Rename failed', 'error');
    }
}

function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
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
            const selectBtn = e.target.closest('.player-select-btn');
            if (selectBtn) {
                const name = selectBtn.getAttribute('data-player') || '';
                selectPlayer(name);
                return;
            }
            const renameBtn = e.target.closest('.player-rename-btn');
            if (renameBtn) {
                const name = renameBtn.getAttribute('data-rename-player') || '';
                if (name) openRenameForm(name);
                return;
            }
            const cancelBtn = e.target.closest('.player-rename-cancel');
            if (cancelBtn) {
                const name = cancelBtn.getAttribute('data-rename-cancel') || '';
                if (name) closeRenameForm(name);
                return;
            }
            const saveBtn = e.target.closest('.player-rename-save');
            if (saveBtn) {
                const name = saveBtn.getAttribute('data-rename-save') || '';
                if (name) saveRename(name);
                return;
            }
        });
    }

    // Kick off an initial refresh so the button reveals itself once the
    // backend reports multi-instance mode.
    refreshPlayers();
}
