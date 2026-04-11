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
    pixelScrollEnabled,
    pixelScrollSpeed,
    setLastLyrics,
    setUpdateInProgress
} from './state.js';
import { areLyricsDifferent } from './utils.js';
import { animatePixelScroll } from './pixelScroll.js';
// Note: Word-sync imports removed - animation loop is now single authority for lyrics during word-sync

// Read the current translateY value (px) from an element's inline style.
function getTranslateY(el) {
    const t = el.style.transform;
    if (!t) return 0;
    const m = t.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
    return m ? parseFloat(m[1]) : 0;
}

// Line-sync continuous pixel-scroll state
let lineSyncContinuousScrollActive = false;
let lineSyncTimingAnchor = null;
let lineSyncAnchorPerfTs = 0;
let lineSyncRafId = null;
let lineSyncLastFrameLogTs = 0;
let lineSyncLastUpdateLogTs = 0;
let lineDemotionResetTimer = null;

function lerp(a, b, t) {
    return a + ((b - a) * t);
}

function applyLineSyncMorph(progress) {
    const p = Math.max(0, Math.min(1, progress));
    const prev2 = document.getElementById('prev-2');
    const prev1 = document.getElementById('prev-1');
    const current = document.getElementById('current');
    const next1 = document.getElementById('next-1');
    const next2 = document.getElementById('next-2');

    const applyMorph = (el, fromState, toState) => {
        if (!el) return;
        const scale = lerp(fromState.scale, toState.scale, p);
        const opacity = lerp(fromState.opacity, toState.opacity, p);
        const blur = lerp(fromState.blur, toState.blur, p);
        const y = lerp(fromState.y, toState.y, p);
        el.style.opacity = `${opacity}`;
        el.style.filter = blur > 0.01 ? `blur(${blur.toFixed(2)}px)` : '';
        el.style.transform = `translateY(${y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    };

    // State model for smooth continuous movement
    const far = { scale: 0.72, opacity: 0.40, blur: 1.0, y: 10 };
    const adjacent = { scale: 1.0, opacity: 0.70, blur: 0.0, y: 5 };
    const active = { scale: 1.62, opacity: 1.0, blur: 0.0, y: 0 };

    applyMorph(prev2, far, far);
    applyMorph(prev1, adjacent, far);
    applyMorph(current, active, adjacent);
    applyMorph(next1, adjacent, active);
    applyMorph(next2, far, adjacent);
}

function clearLineSyncMorphStyles() {
    ['prev-2', 'prev-1', 'current', 'next-1', 'next-2', 'next-3'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.opacity = '';
        el.style.filter = '';
        el.style.transform = '';
    });
}

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

    const pixelScrollActive = document.getElementById('lyrics')
        ?.classList.contains('pixel-scroll-mode');

    // Core DOM update: replace text content of all six lyric line elements
    const applyUpdate = () => {
        const previousEl = document.getElementById('prev-1');
        const currentEl = document.getElementById('current');
        const hadOutgoingAnticipation = !!(currentEl && currentEl.classList.contains('line-anticipating-previous'));
        if (previousEl) {
            previousEl.classList.remove('line-demoting-from-current');
        }

        // If current line is in outgoing anticipation state, clear it BEFORE swapping
        // text so the new incoming current line doesn't inherit a temporary shrunken
        // style and trigger a second "grow" pulse right after transition.
        if (hadOutgoingAnticipation && currentEl) {
            currentEl.style.transition = 'none';
            currentEl.classList.remove('line-anticipating-previous');
            currentEl.getBoundingClientRect(); // flush snap removal
            currentEl.style.transition = '';
        } else if (currentEl) {
            currentEl.classList.remove('line-anticipating-previous');
        }

        updateLyricElement(document.getElementById('prev-2'), lyrics[0]);
        updateLyricElement(document.getElementById('prev-1'), lyrics[1]);
        updateLyricElement(currentEl, lyrics[2]);
        updateLyricElement(document.getElementById('next-1'), lyrics[3]);
        updateLyricElement(document.getElementById('next-2'), lyrics[4]);
        updateLyricElement(document.getElementById('next-3'), lyrics[5]);

        // Prevent stale anticipation from briefly inflating the newly assigned next line.
        // Disable transitions first so the new content snaps to next-size instantly —
        // we don't want the shrink animation playing on the brand-new text.
        const nextEl = document.getElementById('next-1');
        if (nextEl && nextEl.classList.contains('line-anticipating-current')) {
            nextEl.style.transition = 'none';
            nextEl.classList.remove('line-anticipating-current');
            nextEl.getBoundingClientRect(); // flush so the instant resize is committed
            nextEl.style.transition = '';
        } else if (nextEl) {
            nextEl.classList.remove('line-anticipating-current');
        }

        // Smoothly shrink old active line into previous slot on step transitions.
        // Single rAF keeps grow/shrink nearly concurrent at the boundary while still
        // giving the browser one frame to commit the "from" style.
        // Skip fallback demotion when outgoing anticipation was already active;
        // otherwise we get a second size-change pulse after the boundary.
        const shouldDemote = (isForward || isBackward)
            && !hadOutgoingAnticipation
            && !pixelScrollActive;
        if (shouldDemote && previousEl) {
            previousEl.classList.add('line-demoting-from-current');
            requestAnimationFrame(() => {
                previousEl.classList.remove('line-demoting-from-current');
            });
            if (lineDemotionResetTimer) clearTimeout(lineDemotionResetTimer);
            lineDemotionResetTimer = setTimeout(() => {
                previousEl.classList.remove('line-demoting-from-current');
                lineDemotionResetTimer = null;
            }, 900);
        }
    };

    // Pixel scroll: animate a translateY slide for sequential line advances.
    // The CSS class on #lyrics is the canonical on/off flag — works in both the
    // main app (set by api.js from server config) and the sandbox (set directly).
    // Seeks and jumps fall back to the instant update so the display never stalls.
    if (pixelScrollActive) {
        logLineSyncDebug('Lyrics window update', {
            isForward,
            isBackward,
            lineSyncContinuousScrollActive,
            current: lyrics[2],
            next: lyrics[3]
        }, 120);
    }
    if (pixelScrollActive && (isForward || isBackward)) {
        if (lineSyncContinuousScrollActive) {
            const inner = document.getElementById('lyrics-scroll-inner');
            const currentEl = document.getElementById('current');
            const nextEl = document.getElementById('next-1');
            let handoffCarryTranslate = 0;
            if (inner && currentEl && nextEl) {
                const beforeTranslate = getTranslateY(inner);
                const currentRect = currentEl.getBoundingClientRect();
                const nextRect = nextEl.getBoundingClientRect();
                const currentCenterY = currentRect.top + (currentRect.height / 2);
                const nextCenterY = nextRect.top + (nextRect.height / 2);
                const centerOffset = nextCenterY - currentCenterY;
                handoffCarryTranslate = beforeTranslate + centerOffset;
            }
            stopLineSyncContinuousScroll(false, 'line-change');
            clearLineSyncMorphStyles();

            // Before measuring or applying text, instantly collapse the next-1
            // anticipation size so it doesn't skew the upcoming layout.
            const preNext = document.getElementById('next-1');
            if (preNext && preNext.classList.contains('line-anticipating-current')) {
                preNext.style.transition = 'none';
                preNext.classList.remove('line-anticipating-current');
                preNext.getBoundingClientRect();
                preNext.style.transition = '';
            }

            applyUpdate();

            // IMPORTANT: do not run a second recenter tween here. Continuous scroll
            // already performed the movement; animating back to 0 creates the second
            // visible "scroll pulse" and typography jitter users reported.
            if (inner) {
                inner.style.transition = 'none';
                inner.style.transform = `translateY(${handoffCarryTranslate}px)`;
            }
        } else {
            // Pre-remove anticipation class before animatePixelScroll measures positions
            // so the offset is based on the natural (smaller) next-1 size — preventing
            // the scroll animation from starting too far out.
            const preNext = document.getElementById('next-1');
            if (isForward && preNext && preNext.classList.contains('line-anticipating-current')) {
                preNext.style.transition = 'none';
                preNext.classList.remove('line-anticipating-current');
                preNext.getBoundingClientRect();
                preNext.style.transition = '';
            }
            animatePixelScroll(applyUpdate, isForward);
        }
    } else {
        applyUpdate();
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
    const currentEl = document.getElementById('current');
    const inner = document.getElementById('lyrics-scroll-inner');
    if (nextEl) nextEl.classList.remove('line-anticipating-current');
    if (currentEl) currentEl.classList.remove('line-anticipating-previous');
    clearLineSyncMorphStyles();
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
    const currentCenterY = currentRect.top + (currentRect.height / 2);
    const nextCenterY = nextRect.top + (nextRect.height / 2);
    const offset = nextCenterY - currentCenterY;
    if (Math.abs(offset) >= 1) {
        const translateY = -(offset * dynamicProgress);
        inner.style.transition = 'none';
        inner.style.transform = `translateY(${translateY}px)`;
    }

    applyLineSyncMorph(dynamicProgress);
    const timeToNextMs = Math.max(0, (lineSyncTimingAnchor.timeToNextMs || 0) - elapsedMs);

    if ((now - lineSyncLastFrameLogTs) > 500) {
        lineSyncLastFrameLogTs = now;
        logLineSyncDebug('Frame', {
            elapsedMs: Math.round(elapsedMs),
            durationMs: Math.round(durationMs),
            anchorProgress: Number(anchorProgress.toFixed(4)),
            dynamicProgress: Number(dynamicProgress.toFixed(4)),
            offsetPx: Number(offset.toFixed(2)),
            translateYPx: Number((-(offset * dynamicProgress)).toFixed(2)),
            timeToNextMs: Math.round(timeToNextMs)
        });
    }

    lineSyncRafId = requestAnimationFrame(renderLineSyncContinuousScroll);
}

export function updateLineSyncAnticipation(timing) {
    const lyricsEl = document.getElementById('lyrics');
    if (!lyricsEl) return;

    // Self-heal: keep the CSS mode class aligned with global setting.
    // Word-sync transitions can temporarily rebuild/remove DOM and may desync class state.
    if (pixelScrollEnabled && !lyricsEl.classList.contains('pixel-scroll-mode')) {
        lyricsEl.classList.add('pixel-scroll-mode');
        logLineSyncDebug('Recovered missing pixel-scroll-mode class from state');
    }

    // Do not interfere with word-sync renderer modes.
    if (hasWordSync && wordSyncEnabled) {
        // Stop line-sync RAF/state, but DO NOT reset shared inner transform here.
        // Word-sync pixel renderer owns #lyrics-scroll-inner transform while active.
        stopLineSyncContinuousScroll(false, 'word-sync-active');
        const nextEl = document.getElementById('next-1');
        const currentEl = document.getElementById('current');
        if (nextEl) nextEl.classList.remove('line-anticipating-current');
        if (currentEl) currentEl.classList.remove('line-anticipating-previous');
        return;
    }

    const pixelScrollActive = lyricsEl.classList.contains('pixel-scroll-mode');
    const lineProgress = timing?.line_progress;
    const lineDurationMs = timing?.line_duration_ms;
    const timeToNextMs = timing?.time_to_next_ms;
    const canAnticipate = pixelScrollActive
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
        canAnticipate,
        currentLine: document.getElementById('current')?.textContent || '',
        nextLine: document.getElementById('next-1')?.textContent || ''
    }, 120);

    if (!canAnticipate) {
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
    return;
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
