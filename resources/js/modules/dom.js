/**
 * dom.js - DOM Manipulation Helpers
 * 
 * This module contains DOM manipulation functions and UI helpers.
 * Centralizes all direct DOM access for consistency.
 * 
 * Level 1 - Imports: state
 */

import {
    lastLyrics,
    updateInProgress,
    visualModeActive,
    hasWordSync,
    wordSyncEnabled,
    lineSyncedTiming,
    wordSyncAnchorPosition,
    wordSyncAnchorTimestamp,
    wordSyncIsPlaying,
    wordSyncLatencyCompensation,
    setLastLyrics,
    setUpdateInProgress
} from './state.js';
import { areLyricsDifferent } from './utils.js';
import { animatePixelScroll } from './pixelScroll.js';
// Note: Word-sync imports removed - animation loop is now single authority for lyrics during word-sync

// ========== ELEMENT CACHE ==========
// Cache for frequently accessed elements
const elementCache = new Map();
let lineSyncAnimationId = null;
let currentTimingIndex = -1;
const LINE_ANTICIPATION_MS = 220;

/**
 * Get element by ID with caching
 * 
 * @param {string} id - Element ID
 * @returns {HTMLElement|null} The element or null
 */
export function getElement(id) {
    if (!elementCache.has(id)) {
        elementCache.set(id, document.getElementById(id));
    }
    return elementCache.get(id);
}

/**
 * Clear element cache (call when DOM changes significantly)
 */
export function clearElementCache() {
    elementCache.clear();
}

// ========== LYRIC ELEMENT UPDATES ==========

/**
 * Update a lyric element's text content only if changed
 * 
 * @param {HTMLElement} element - The element to update
 * @param {string} text - New text content
 */
export function updateLyricElement(element, text) {
    if (element && element.textContent !== text) {
        element.textContent = text;
    }
}

/**
 * Set lyrics in the DOM
 * 
 * @param {Array|Object} lyrics - Lyrics array or object with msg property
 */
export function setLyricsInDom(lyrics) {
    if (updateInProgress) return;
    if (!Array.isArray(lyrics)) {
        lyrics = ['', '', lyrics.msg || '', '', '', ''];
    }

    // When word-sync is active and enabled, the animation loop (wordSync.js) is
    // the SINGLE AUTHORITY for all 6 lyric lines. It updates surrounding lines
    // exactly when line changes, preventing timing mismatches.
    // We still need to handle the initial state before animation starts.
    if (hasWordSync && wordSyncEnabled) {
        // Only update lastLyrics for tracking, but don't touch DOM
        setLastLyrics([...lyrics]);
        return;
    }

    // Line-sync mode: handle normally with change detection
    if (!areLyricsDifferent(lastLyrics, lyrics)) {
        return;
    }

    // Detect whether this is a single step forward or backward through the song.
    // Pixel scroll only animates step-by-step advances; seeks/jumps fall back to
    // the default instant class-swap so the display never looks stuck.
    const isForward  = !!(lastLyrics && Array.isArray(lastLyrics) && lyrics[2] === lastLyrics[3]);
    const isBackward = !!(lastLyrics && Array.isArray(lastLyrics) && lyrics[2] === lastLyrics[1]);

    setUpdateInProgress(true);
    setLastLyrics([...lyrics]);

    // Core DOM update: replace text content of all six lyric line elements
    const applyUpdate = () => {
        updateLyricElement(document.getElementById('prev-2'), lyrics[0]);
        updateLyricElement(document.getElementById('prev-1'), lyrics[1]);
        updateLyricElement(document.getElementById('current'), lyrics[2]);
        updateLyricElement(document.getElementById('next-1'), lyrics[3]);
        updateLyricElement(document.getElementById('next-2'), lyrics[4]);
        updateLyricElement(document.getElementById('next-3'), lyrics[5]);
        updateLineSyncActiveState();
        updateCurrentTimingIndex(lyrics[2]);
    };

    // Pixel scroll: animate a translateY slide for sequential line advances.
    // The CSS class on #lyrics is the canonical on/off flag — works in both the
    // main app (set by api.js from server config) and the sandbox (set directly).
    // Seeks and jumps fall back to the instant update so the display never stalls.
    const pixelScrollActive = document.getElementById('lyrics')
        ?.classList.contains('pixel-scroll-mode');
    const currentEl = document.getElementById('current');
    const runSmoothSwap = () => {
        if (!currentEl) {
            applyUpdate();
            return;
        }
        currentEl.classList.remove('line-entering');
        currentEl.classList.add('line-exiting');
        setTimeout(() => {
            applyUpdate();
            currentEl.classList.remove('line-exiting');
            currentEl.classList.add('line-entering');
            setTimeout(() => currentEl.classList.remove('line-entering'), 180);
        }, 90);
    };

    if (pixelScrollActive && (isForward || isBackward)) {
        animatePixelScroll(runSmoothSwap, isForward);
    } else {
        runSmoothSwap();
    }

    // Self-healing: If we are showing lyrics and NOT in visual mode, ensure the hidden class is gone
    if (!visualModeActive) {
        const lyricsContainer = document.getElementById('lyrics');
        if (lyricsContainer && lyricsContainer.classList.contains('visual-mode-hidden')) {
            console.log('[Visual Mode] Found hidden class while inactive - removing (Self-healing)');
            lyricsContainer.classList.remove('visual-mode-hidden');
        }
    }

    setTimeout(() => {
        setUpdateInProgress(false);
    }, 100);

    ensureLineSyncAnimationLoop();
}

function normalizeLineText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function updateCurrentTimingIndex(currentText) {
    if (!Array.isArray(lineSyncedTiming) || lineSyncedTiming.length === 0) {
        currentTimingIndex = -1;
        return;
    }
    const target = normalizeLineText(currentText);
    if (!target) {
        currentTimingIndex = -1;
        return;
    }

    const startIdx = Math.max(0, currentTimingIndex - 4);
    const endIdx = Math.min(lineSyncedTiming.length, currentTimingIndex + 6);
    for (let i = startIdx; i < endIdx; i++) {
        if (normalizeLineText(lineSyncedTiming[i]?.text) === target) {
            currentTimingIndex = i;
            return;
        }
    }
    const fallbackIdx = lineSyncedTiming.findIndex((line) => normalizeLineText(line?.text) === target);
    currentTimingIndex = fallbackIdx;
}

function getLineSyncPosition() {
    if (!wordSyncAnchorTimestamp) return wordSyncAnchorPosition || 0;
    const elapsed = Math.max(0, (performance.now() - wordSyncAnchorTimestamp) / 1000);
    return (wordSyncAnchorPosition || 0) + (wordSyncIsPlaying ? elapsed : 0) + (wordSyncLatencyCompensation || 0);
}

function updateLineSyncActiveState() {
    const currentEl = document.getElementById('current');
    if (!currentEl) return;
    currentEl.classList.toggle('line-sync-active', !hasWordSync || !wordSyncEnabled);
}

function ensureLineSyncAnimationLoop() {
    if (lineSyncAnimationId !== null) return;
    const loop = () => {
        lineSyncAnimationId = requestAnimationFrame(loop);
        if (hasWordSync && wordSyncEnabled) return;
        if (!Array.isArray(lineSyncedTiming) || currentTimingIndex < 0) return;

        const nextEl = document.getElementById('next-1');
        if (!nextEl) return;

        const nextLine = lineSyncedTiming[currentTimingIndex + 1];
        if (!nextLine || typeof nextLine.start !== 'number') {
            nextEl.classList.remove('line-anticipating-current');
            return;
        }

        const position = getLineSyncPosition();
        const msUntilNext = (nextLine.start - position) * 1000;
        const shouldAnticipate = msUntilNext <= LINE_ANTICIPATION_MS && msUntilNext > -120;
        nextEl.classList.toggle('line-anticipating-current', shouldAnticipate);
    };
    loop();
}

// ========== THEME COLOR ==========

/**
 * Update the theme-color meta tag dynamically when album colors change.
 * This updates the Android status bar and task switcher preview color.
 * 
 * @param {string} color - The color to set (hex format, e.g., "#1db954")
 */
export function updateThemeColor(color) {
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor && color) {
        metaThemeColor.setAttribute('content', color);
    }
}

// ========== TOAST NOTIFICATIONS ==========

/**
 * Show a toast notification
 * 
 * @param {string} message - Message to display
 * @param {string} type - 'success' or 'error'
 * @param {number} durationMs - Duration in milliseconds (default 3000)
 */
export function showToast(message, type = 'success', durationMs = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, durationMs);
}

// ========== UTILITY DOM FUNCTIONS ==========

/**
 * Toggle a class on an element based on a condition
 * 
 * @param {HTMLElement} element - The element
 * @param {string} className - Class name to toggle
 * @param {boolean} condition - Whether to add (true) or remove (false) the class
 */
export function toggleClass(element, className, condition) {
    if (element) {
        element.classList.toggle(className, condition);
    }
}

/**
 * Set visibility of an element
 * 
 * @param {HTMLElement|string} elementOrId - Element or element ID
 * @param {boolean} visible - Whether to show (true) or hide (false)
 * @param {string} displayType - CSS display type when visible (default: 'block')
 */
export function setVisible(elementOrId, visible, displayType = 'block') {
    const element = typeof elementOrId === 'string'
        ? document.getElementById(elementOrId)
        : elementOrId;
    if (element) {
        element.style.display = visible ? displayType : 'none';
    }
}

/**
 * Safely encode a URL for use in CSS background-image
 * 
 * @param {string} url - URL to encode
 * @returns {string} Safe URL for CSS
 */
export function encodeBackgroundUrl(url) {
    return encodeURI(url);
}
