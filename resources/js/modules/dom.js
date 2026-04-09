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
    setLastLyrics,
    setUpdateInProgress
} from './state.js';
import { areLyricsDifferent } from './utils.js';
import { animatePixelScroll } from './pixelScroll.js';
// Note: Word-sync imports removed - animation loop is now single authority for lyrics during word-sync

// Line-sync continuous pixel-scroll state
let lineSyncContinuousScrollActive = false;
let lineSyncTimingAnchor = null;
let lineSyncAnchorPerfTs = 0;
let lineSyncRafId = null;
let lineSyncLastFrameLogTs = 0;
let lineSyncLastUpdateLogTs = 0;

function logLineSyncDebug(message, data = null, throttleMs = 0) {
    const now = performance.now();
    if (throttleMs > 0 && (now - lineSyncLastUpdateLogTs) < throttleMs) return;
    if (throttleMs > 0) lineSyncLastUpdateLogTs = now;
    if (data !== null) {
        console.log(`[LineSyncPixel] ${message}`, data);
    } else {
        console.log(`[LineSyncPixel] ${message}`);
    }
}

// ========== ELEMENT CACHE ==========
// Cache for frequently accessed elements
const elementCache = new Map();

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
    };

    // Pixel scroll: animate a translateY slide for sequential line advances.
    // The CSS class on #lyrics is the canonical on/off flag — works in both the
    // main app (set by api.js from server config) and the sandbox (set directly).
    // Seeks and jumps fall back to the instant update so the display never stalls.
    const pixelScrollActive = document.getElementById('lyrics')
        ?.classList.contains('pixel-scroll-mode');
    if (pixelScrollActive) {
        logLineSyncDebug('Lyrics window update', {
            isForward,
            isBackward,
            lineSyncContinuousScrollActive,
            current: lyrics[2],
            next: lyrics[3]
        }, 120);
    }
    if (pixelScrollActive && (isForward || isBackward) && !lineSyncContinuousScrollActive) {
        animatePixelScroll(applyUpdate, isForward);
    } else {
        applyUpdate();
        // In continuous line-sync mode, each poll frame controls transform directly.
        // After a line boundary update, hard-reset transform so the new text window
        // starts from the top of the next interval without visual drift.
        if (lineSyncContinuousScrollActive) {
            const inner = document.getElementById('lyrics-scroll-inner');
            if (inner) {
                inner.style.transition = 'none';
                inner.style.transform = 'translateY(0)';
            }
        }
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
}

/**
 * Apply line-sync anticipation styling for upcoming line in pixel-scroll mode.
 * This runs every poll tick (not only on lyric text changes) so the next line
 * can smoothly grow before the line boundary.
 *
 * @param {Object|null} timing - line_sync_timing from /lyrics payload
 */
function stopLineSyncContinuousScroll(resetDom = true, reason = 'unknown') {
    if (lineSyncContinuousScrollActive || lineSyncTimingAnchor) {
        logLineSyncDebug(`Stopping continuous scroll (reason=${reason}, resetDom=${resetDom})`);
    }
    lineSyncContinuousScrollActive = false;
    lineSyncTimingAnchor = null;
    lineSyncAnchorPerfTs = 0;
    if (lineSyncRafId) {
        cancelAnimationFrame(lineSyncRafId);
        lineSyncRafId = null;
    }

    if (!resetDom) return;
    const nextEl = document.getElementById('next-1');
    const inner = document.getElementById('lyrics-scroll-inner');
    if (nextEl) nextEl.classList.remove('line-anticipating-current');
    if (inner) {
        inner.style.transition = '';
        inner.style.transform = '';
    }
}

function renderLineSyncContinuousScroll() {
    lineSyncRafId = null;
    if (!lineSyncContinuousScrollActive || !lineSyncTimingAnchor) return;

    const nextEl = document.getElementById('next-1');
    const currentEl = document.getElementById('current');
    const inner = document.getElementById('lyrics-scroll-inner');
    const lyricsEl = document.getElementById('lyrics');
    if (!nextEl || !currentEl || !inner || !lyricsEl) {
        stopLineSyncContinuousScroll(true, 'missing-dom-elements');
        return;
    }

    if (hasWordSync && wordSyncEnabled) {
        stopLineSyncContinuousScroll(true, 'word-sync-active');
        return;
    }

    if (!lyricsEl.classList.contains('pixel-scroll-mode')) {
        stopLineSyncContinuousScroll(true, 'pixel-scroll-disabled');
        return;
    }

    const now = performance.now();
    const elapsedMs = Math.max(0, now - lineSyncAnchorPerfTs);
    const durationMs = Math.max(1, lineSyncTimingAnchor.lineDurationMs || 1);
    const anchorProgress = Math.max(0, Math.min(1, lineSyncTimingAnchor.lineProgress || 0));
    const dynamicProgress = Math.max(0, Math.min(1, anchorProgress + (elapsedMs / durationMs)));

    const currentRect = currentEl.getBoundingClientRect();
    const nextRect = nextEl.getBoundingClientRect();
    const offset = nextRect.top - currentRect.top;
    if (Math.abs(offset) >= 1) {
        const translateY = -(offset * dynamicProgress);
        inner.style.transition = 'none';
        inner.style.transform = `translateY(${translateY}px)`;
    }

    const timeToNextMs = Math.max(0, (lineSyncTimingAnchor.timeToNextMs || 0) - elapsedMs);
    const anticipationMs = 900;
    const shouldAnticipate = timeToNextMs >= 0 && timeToNextMs <= anticipationMs;
    nextEl.classList.toggle('line-anticipating-current', shouldAnticipate);

    if ((now - lineSyncLastFrameLogTs) > 500) {
        lineSyncLastFrameLogTs = now;
        logLineSyncDebug('Frame', {
            elapsedMs: Math.round(elapsedMs),
            durationMs: Math.round(durationMs),
            anchorProgress: Number(anchorProgress.toFixed(4)),
            dynamicProgress: Number(dynamicProgress.toFixed(4)),
            offsetPx: Number(offset.toFixed(2)),
            translateYPx: Number((-(offset * dynamicProgress)).toFixed(2)),
            timeToNextMs: Math.round(timeToNextMs),
            shouldAnticipate
        });
    }

    lineSyncRafId = requestAnimationFrame(renderLineSyncContinuousScroll);
}

export function updateLineSyncAnticipation(timing) {
    const lyricsEl = document.getElementById('lyrics');
    if (!lyricsEl) return;

    // Do not interfere with word-sync renderer modes.
    if (hasWordSync && wordSyncEnabled) {
        // Stop line-sync RAF/state, but DO NOT reset shared inner transform here.
        // Word-sync pixel renderer owns #lyrics-scroll-inner transform while active.
        stopLineSyncContinuousScroll(false, 'word-sync-active');
        const nextEl = document.getElementById('next-1');
        if (nextEl) nextEl.classList.remove('line-anticipating-current');
        return;
    }

    const pixelScrollActive = lyricsEl.classList.contains('pixel-scroll-mode');
    const lineProgress = timing?.line_progress;
    const lineDurationMs = timing?.line_duration_ms;
    const timeToNextMs = timing?.time_to_next_ms;
    const canContinuousScroll = pixelScrollActive
        && typeof lineProgress === 'number'
        && typeof lineDurationMs === 'number'
        && typeof timeToNextMs === 'number'
        && lineDurationMs > 0
        && lineProgress >= 0
        && lineProgress <= 1;

    logLineSyncDebug('Timing tick', {
        pixelScrollActive,
        hasTiming: !!timing,
        lineProgress,
        lineDurationMs,
        timeToNextMs,
        canContinuousScroll,
        currentLine: document.getElementById('current')?.textContent || '',
        nextLine: document.getElementById('next-1')?.textContent || ''
    }, 120);

    if (!canContinuousScroll) {
        stopLineSyncContinuousScroll(true, 'invalid-or-missing-timing');
        return;
    }

    lineSyncContinuousScrollActive = true;
    lineSyncTimingAnchor = {
        lineProgress,
        lineDurationMs,
        timeToNextMs
    };
    lineSyncAnchorPerfTs = performance.now();
    logLineSyncDebug('Anchor updated', {
        lineProgress: Number(lineProgress.toFixed(4)),
        lineDurationMs: Math.round(lineDurationMs),
        timeToNextMs: Math.round(timeToNextMs)
    });

    if (!lineSyncRafId) {
        logLineSyncDebug('Starting RAF loop');
        lineSyncRafId = requestAnimationFrame(renderLineSyncContinuousScroll);
    }
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
