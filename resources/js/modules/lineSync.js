/**
 * lineSync.js - Smooth Line-Synced Lyrics Module
 *
 * Provides smooth, pixel-accurate line-sync display following the same
 * architecture as wordSync.js pixel-scroll mode:
 *
 * - Full-list DOM: All lyrics lines pre-rendered for smooth transitions
 * - Flywheel clock: Monotonic timer that never goes backwards
 * - Pixel-by-pixel scrolling: Position-interpolated translateY
 * - Font inflate/deflate: CSS transitions for smooth size changes
 * - Active line highlighting: Glow effect matching word-sync style
 * - Anticipatory pre-grow: Next line starts growing before it becomes active
 *
 * Activates when line timing data is available and word-sync is NOT active.
 *
 * Level 2 - Imports: state
 */

import {
    lineSyncedLyrics,
    hasLineSync,
    hasWordSync,
    wordSyncEnabled,
    wordSyncAnchorPosition,
    wordSyncAnchorTimestamp,
    wordSyncIsPlaying,
    wordSyncLatencyCompensation,
    wordSyncTransitionMs,
    pixelScrollSpeed
} from './state.js';


// ========== MODULE STATE ==========

let lineSyncAnimationId = null;

// FLYWHEEL CLOCK: Monotonic time that never goes backwards
let visualPosition = 0;
let lastFrameTime = 0;
let visualSpeed = 1.0;
let filteredDrift = 0;
let renderPosition = 0;

// Active line tracking
let activeLineIndex = -1;

// Full-list DOM state
let fullListInitialized = false;
let currentTrackSignature = null;

// Logging
let _lineSyncLogged = false;

// Frame rate limiting - cap at 60 FPS
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;
let lastAnimationTime = 0;

// Drift filtering (EMA)
const DRIFT_SMOOTHING = 0.3;

// Render position smoothing
const RENDER_SMOOTHING = 0.25;

// Line change tracking for safe back-snaps
const BACK_SNAP_WINDOW_MS = 500;
let lineChangeTime = 0;

// Safe-snap zone flag
let inSafeSnapZone = false;

// Outro detection
const OUTRO_VISUAL_MODE_DELAY_SEC = 6.0;
let outroToken = 0;
let activeOutroToken = 0;

// Intro tracking
let introDisplayed = false;

// Scroll smoothing - lerp toward target to absorb layout jitter
// during font-size transitions on wrapped lines
let currentScrollY = 0;
let scrollInitialized = false;
const SCROLL_SMOOTHING = 0.18;   // Lower = smoother (0.18 ≈ 90% in ~12 frames / 200ms)
const SCROLL_SNAP_PX = 0.5;     // Snap to target when within this distance

// Per-line class cache - avoids resetting className every frame
// which triggers expensive style recalculation for every visible line
let lineClassCache = [];


// ========== UTILITIES ==========

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}


// ========== FLYWHEEL CLOCK ==========

/**
 * Update the flywheel clock for line-sync.
 * Same algorithm as wordSync.js but uses only base latency compensation
 * (no word-sync specific offsets).
 *
 * @param {number} timestamp - rAF timestamp
 * @returns {number} Current visual position in seconds
 */
function updateFlywheelClock(timestamp) {
    const dt = lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 0;
    lastFrameTime = timestamp;

    if (!wordSyncIsPlaying) {
        return visualPosition;
    }

    // Server position: anchor + elapsed + source-based latency only
    const elapsed = (performance.now() - wordSyncAnchorTimestamp) / 1000;
    const serverPosition = wordSyncAnchorPosition + elapsed + wordSyncLatencyCompensation;

    const rawDrift = serverPosition - visualPosition;

    // Large jump (seek) - snap immediately
    if (Math.abs(rawDrift) > 0.5) {
        visualPosition = serverPosition;
        renderPosition = serverPosition;
        visualSpeed = 1.0;
        filteredDrift = 0;
        return visualPosition;
    }

    // Safe-zone snap during line transitions
    const inLineChangeWindow = lineChangeTime > 0 &&
        (performance.now() - lineChangeTime) < BACK_SNAP_WINDOW_MS;
    const canSafeSnap = inLineChangeWindow || inSafeSnapZone;

    if (Math.abs(rawDrift) > 0.03 && Math.abs(rawDrift) < 0.5 && canSafeSnap) {
        visualPosition = serverPosition;
        renderPosition = serverPosition;
        visualSpeed = 1.0;
        filteredDrift = 0;
        lineChangeTime = 0;
        return visualPosition;
    }

    // Drift filtering (EMA)
    filteredDrift = filteredDrift * (1 - DRIFT_SMOOTHING) + rawDrift * DRIFT_SMOOTHING;

    // Deadband - ignore tiny drift
    if (Math.abs(filteredDrift) < 0.03) {
        visualSpeed = 1.0;
    } else {
        visualSpeed = 1.0 + (filteredDrift * 0.8);
        visualSpeed = Math.max(0.90, Math.min(1.10, visualSpeed));
    }

    visualPosition += dt * visualSpeed;
    renderPosition = renderPosition + (visualPosition - renderPosition) * RENDER_SMOOTHING;

    return visualPosition;
}


// ========== DOM MANAGEMENT ==========

/**
 * Inject the dynamic CSS for line-sync full-list mode.
 * Only done once per page.
 */
function injectLineSyncCSS() {
    if (document.getElementById('ls-pixel-scroll-css')) return;

    const style = document.createElement('style');
    style.id = 'ls-pixel-scroll-css';
    style.textContent = `
        .lyrics-container.line-sync-mode {
            position: relative;
            overflow: hidden;
        }
        .lyrics-container.line-sync-mode #lyrics-scroll-inner {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            will-change: transform;
            padding-top: 50vh !important;
            padding-bottom: 50vh !important;
            display: flex !important;
            flex-direction: column !important;
        }
        .lyrics-container.line-sync-mode .lyric-line {
            will-change: font-size, opacity;
        }
        .lyrics-container.line-sync-mode .lyric-line.out-of-bounds {
            opacity: 0 !important;
            pointer-events: none !important;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Build the full-list DOM with all lyrics lines pre-rendered.
 * Mirrors buildFullListDOM() from wordSync.js.
 */
function buildLineSyncDOM() {
    const container = document.getElementById('lyrics');
    const inner = document.getElementById('lyrics-scroll-inner');
    if (!container || !inner || !lineSyncedLyrics) return;

    injectLineSyncCSS();

    container.classList.add('line-sync-mode');
    container.classList.add('pixel-scroll-mode');

    let html = '';
    lineSyncedLyrics.forEach((line, idx) => {
        const text = escapeHtml(line.text || '');
        html += `<div class="lyric-line far-next out-of-bounds" id="ls-line-${idx}">${text}</div>`;
    });

    inner.innerHTML = html;
    fullListInitialized = true;

    // Reset class cache and scroll state for the new track
    lineClassCache = new Array(lineSyncedLyrics.length).fill('');
    currentScrollY = 0;
    scrollInitialized = false;

    const firstLine = lineSyncedLyrics[0];
    currentTrackSignature = firstLine ? firstLine.start : 'empty';
}

/**
 * Restore the original 6-slot DOM structure.
 */
function destroyLineSyncDOM() {
    const container = document.getElementById('lyrics');
    if (container) {
        container.classList.remove('line-sync-mode');
        container.classList.remove('pixel-scroll-mode');
    }

    const inner = document.getElementById('lyrics-scroll-inner');
    if (inner) {
        inner.innerHTML = `
            <div id="prev-2" class="lyric-line far-previous"></div>
            <div id="prev-1" class="lyric-line previous"></div>
            <div id="current" class="lyric-line current"></div>
            <div id="next-1" class="lyric-line next"></div>
            <div id="next-2" class="lyric-line far-next"></div>
            <div id="next-3" class="lyric-line far-next"></div>
        `;
        inner.style.transform = '';
    }

    fullListInitialized = false;
    currentTrackSignature = null;
}


// ========== FRAME UPDATE ==========

/**
 * Determine the CSS role string for a line given the active index.
 * Returns a class-suffix string that is appended to 'lyric-line '.
 */
function getLineRole(i, activeIdx, shouldAnticipateNext) {
    if (i < activeIdx - 2 || i > activeIdx + 3) return 'out-of-bounds';
    if (i === activeIdx) return 'current line-sync-highlight';
    if (i === activeIdx - 1) return 'previous';
    if (i === activeIdx + 1) {
        return shouldAnticipateNext ? 'next line-anticipating-current' : 'next';
    }
    if (i === activeIdx - 2) return 'far-previous';
    return 'far-next';
}

/**
 * Per-frame update: assign CSS classes and compute scroll position.
 * Follows the same pattern as updateFullListDOM() in wordSync.js,
 * with two jitter-reduction improvements:
 *
 * 1. CLASS CACHE – only touches an element's className when its role
 *    actually changes, eliminating ~300 redundant style recalcs/sec.
 * 2. SCROLL LERP – exponentially smooths the translateY target so
 *    layout shifts from font-size transitions on wrapped lines are
 *    absorbed instead of causing visible jumps.
 *
 * @param {Array} lines - lineSyncedLyrics array
 * @param {number} position - Current flywheel position in seconds
 */
function updateLineSyncDOM(lines, position) {
    const inner = document.getElementById('lyrics-scroll-inner');
    const container = document.getElementById('lyrics');
    if (!inner || !container || !lines || lines.length === 0) return;

    const containerHalfHeight = container.clientHeight / 2;

    // --- Find active line ---
    let newActiveIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const nextLine = lines[i + 1];
        const start = lines[i].start || 0;
        const end = nextLine ? nextLine.start : (start + 10);
        if (position >= start && position < end) {
            newActiveIdx = i;
            break;
        }
    }
    if (position < (lines[0].start || 0)) newActiveIdx = -1;
    if (newActiveIdx === -1 && position >= (lines[lines.length - 1].start || 0)) {
        newActiveIdx = lines.length - 1;
    }

    // --- Hard sync on line change ---
    if (newActiveIdx !== activeLineIndex && newActiveIdx >= 0) {
        const anchorAgeMs = performance.now() - wordSyncAnchorTimestamp;
        if (anchorAgeMs < 2000) {
            const elapsed = anchorAgeMs / 1000;
            const serverEstimate = wordSyncAnchorPosition + elapsed + wordSyncLatencyCompensation;
            visualPosition = serverEstimate;
            renderPosition = serverEstimate;
            filteredDrift = 0;
            visualSpeed = 1.0;
            lineChangeTime = 0;
        } else {
            lineChangeTime = performance.now();
        }
    }
    activeLineIndex = newActiveIdx;

    // --- Anticipation: pre-grow the upcoming line ---
    const baseTransitionMs = Math.max(120, wordSyncTransitionMs || 200);
    const anticipationMs = Math.max(250, Math.min(1400, baseTransitionMs * 2.5));
    let shouldAnticipateNext = false;
    if (newActiveIdx >= 0 && newActiveIdx + 1 < lines.length) {
        const nextStart = lines[newActiveIdx + 1]?.start;
        if (typeof nextStart === 'number') {
            const timeToNextMs = (nextStart - position) * 1000;
            shouldAnticipateNext = timeToNextMs >= 0 && timeToNextMs <= anticipationMs;
        }
    }

    // --- Update CSS classes (only when role changes) ---
    // Skipping unchanged lines avoids resetting className every frame,
    // which would trigger expensive forced-style-recalculation on
    // every visible element at 60 fps.
    for (let i = 0; i < lines.length; i++) {
        const role = getLineRole(i, newActiveIdx, shouldAnticipateNext);
        if (lineClassCache[i] === role) continue;   // no change – skip DOM write
        lineClassCache[i] = role;
        const el = document.getElementById(`ls-line-${i}`);
        if (el) el.className = 'lyric-line ' + role;
    }

    // --- Calculate raw scroll target ---
    let targetY = 0;

    if (position <= (lines[0].start || 0)) {
        // Before first line - centre on first line
        const el = document.getElementById('ls-line-0');
        if (el) targetY = el.offsetTop + (el.offsetHeight / 2);
    } else {
        let found = false;
        for (let i = 0; i < lines.length - 1; i++) {
            const curr = lines[i];
            const next = lines[i + 1];

            if (position >= curr.start && position < next.start) {
                const currEl = document.getElementById(`ls-line-${i}`);
                const nextEl = document.getElementById(`ls-line-${i + 1}`);

                if (currEl && nextEl) {
                    const currY = currEl.offsetTop + (currEl.offsetHeight / 2);
                    const nextY = nextEl.offsetTop + (nextEl.offsetHeight / 2);

                    const duration = next.start - curr.start;
                    let progress = 0;
                    if (duration > 0.01) {
                        progress = (position - curr.start) / duration;
                    } else {
                        progress = 1.0;
                    }
                    progress = Math.max(0, Math.min(1, progress));

                    // Apply speed curve
                    let speed = 1.0;
                    try { speed = pixelScrollSpeed || 1.0; } catch (e) { /* ignore */ }
                    if (speed !== 1.0 && speed > 0) {
                        progress = Math.pow(progress, speed);
                    }

                    targetY = currY + (nextY - currY) * progress;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            // Past last line
            const lastIdx = lines.length - 1;
            const el = document.getElementById(`ls-line-${lastIdx}`);
            if (el) targetY = el.offsetTop + (el.offsetHeight / 2);
        }
    }

    // --- Smooth scroll (lerp) ---
    // During font-size CSS transitions on wrapped lines the measured
    // offsetTop / offsetHeight values jitter as the browser reflows text.
    // Lerping absorbs those transient layout shifts so the scroll movement
    // stays silky even when a two-line lyric inflates to three lines.
    const goalY = containerHalfHeight - targetY;

    if (!scrollInitialized) {
        currentScrollY = goalY;
        scrollInitialized = true;
    } else {
        const diff = goalY - currentScrollY;
        if (Math.abs(diff) < SCROLL_SNAP_PX) {
            currentScrollY = goalY;
        } else {
            currentScrollY += diff * SCROLL_SMOOTHING;
        }
    }

    inner.style.transform = `translateY(${currentScrollY}px)`;

    // Determine safe-snap zone for flywheel
    if (newActiveIdx === -1) {
        inSafeSnapZone = true;  // intro
    } else if (newActiveIdx >= 0) {
        const line = lines[newActiveIdx];
        const nextLine = lines[newActiveIdx + 1];
        if (nextLine) {
            const remaining = nextLine.start - position;
            inSafeSnapZone = remaining < 0.2;
        } else {
            inSafeSnapZone = position > (line.start + 5);
        }
    }
}


// ========== ANIMATION LOOP ==========

/**
 * Core animation frame callback.
 *
 * @param {DOMHighResTimeStamp} timestamp - rAF timestamp
 */
function animateLineSync(timestamp) {
    // FPS throttle
    if (timestamp - lastAnimationTime < FRAME_INTERVAL) {
        lineSyncAnimationId = requestAnimationFrame(animateLineSync);
        return;
    }
    lastAnimationTime = timestamp;

    // Stop if no data or word-sync took over
    if (!hasLineSync || !lineSyncedLyrics || lineSyncedLyrics.length === 0) {
        cleanupLineSync();
        lineSyncAnimationId = null;
        return;
    }

    if (hasWordSync && wordSyncEnabled) {
        cleanupLineSync();
        lineSyncAnimationId = null;
        return;
    }

    // Build / rebuild DOM when track changes
    const trackSignature = lineSyncedLyrics[0] ? lineSyncedLyrics[0].start : 'empty';
    if (!fullListInitialized || currentTrackSignature !== trackSignature) {
        buildLineSyncDOM();
    }

    if (!_lineSyncLogged) {
        console.log(`[LineSync] Animation started! ${lineSyncedLyrics.length} lines, using flywheel clock`);
        _lineSyncLogged = true;
    }

    // Advance flywheel and render
    const position = updateFlywheelClock(timestamp);
    updateLineSyncDOM(lineSyncedLyrics, position);

    // Handle outro -> visual mode
    const lastLine = lineSyncedLyrics[lineSyncedLyrics.length - 1];
    const lastLineStart = lastLine ? lastLine.start : 0;
    if (position > lastLineStart + 9 && outroToken === 0) {
        outroToken++;
        activeOutroToken = outroToken;
        setTimeout(() => {
            if (outroToken === activeOutroToken) {
                console.log('[LineSync] Outro detected, dispatching visual mode event');
                window.dispatchEvent(new CustomEvent('wordSyncOutro'));
            }
        }, OUTRO_VISUAL_MODE_DELAY_SEC * 1000);
    }

    lineSyncAnimationId = requestAnimationFrame(animateLineSync);
}

/**
 * Clean up all line-sync state and DOM.
 */
function cleanupLineSync() {
    destroyLineSyncDOM();
    visualPosition = 0;
    renderPosition = 0;
    visualSpeed = 1.0;
    lastFrameTime = 0;
    lastAnimationTime = 0;
    filteredDrift = 0;
    activeLineIndex = -1;
    _lineSyncLogged = false;
    inSafeSnapZone = false;
    introDisplayed = false;
    outroToken++;
    activeOutroToken = 0;
    // Reset scroll and class cache
    currentScrollY = 0;
    scrollInitialized = false;
    lineClassCache = [];
}


// ========== PUBLIC API ==========

/**
 * Start the line-sync animation loop.
 * Safe to call multiple times - will not create duplicate loops.
 */
export function startLineSyncAnimation() {
    if (lineSyncAnimationId !== null) return;
    if (!hasLineSync || !lineSyncedLyrics) return;
    // Don't start if word-sync is active
    if (hasWordSync && wordSyncEnabled) return;

    // Initialise flywheel clock from current anchor
    const elapsed = (performance.now() - wordSyncAnchorTimestamp) / 1000;
    visualPosition = wordSyncAnchorPosition + elapsed + wordSyncLatencyCompensation;
    renderPosition = visualPosition;
    visualSpeed = 1.0;
    lastFrameTime = 0;

    activeOutroToken = 0;
    outroToken = 0;

    console.log('[LineSync] Starting animation loop with flywheel clock');
    lineSyncAnimationId = requestAnimationFrame(animateLineSync);
}

/**
 * Stop the line-sync animation loop.
 */
export function stopLineSyncAnimation() {
    if (lineSyncAnimationId !== null) {
        cancelAnimationFrame(lineSyncAnimationId);
        lineSyncAnimationId = null;
        console.log('[LineSync] Animation loop stopped');
    }
    cleanupLineSync();
}

/**
 * Reset line-sync state (call on song change).
 */
export function resetLineSyncState() {
    stopLineSyncAnimation();
    visualPosition = 0;
    visualSpeed = 1.0;
    lastFrameTime = 0;
    activeLineIndex = -1;
    _lineSyncLogged = false;
}

/**
 * Check if line-sync animation is currently running.
 */
export function isLineSyncRunning() {
    return lineSyncAnimationId !== null;
}
