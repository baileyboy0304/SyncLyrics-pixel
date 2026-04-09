/**
 * pixelScroll.js - Pixel-scroll animation for lyric line transitions
 */

import { pixelScrollSpeed } from './state.js';

let isAnimating = false;
let pendingCalls = []; // FIX 2: Use an array queue to prevent dropping lines

export function animatePixelScroll(updateFn, isForward) {
    const lyricsEl = document.getElementById('lyrics');
    const inner    = document.getElementById('lyrics-scroll-inner');

    if (!inner || !lyricsEl || !lyricsEl.classList.contains('pixel-scroll-mode')) {
        updateFn();
        return;
    }

    if (isAnimating) {
        pendingCalls.push({ updateFn, isForward });
        return;
    }

    const currentEl  = document.getElementById('current');
    const neighbourEl = document.getElementById(isForward ? 'next-1' : 'prev-1');

    if (!currentEl || !neighbourEl) {
        updateFn();
        return;
    }

    const currentRect   = currentEl.getBoundingClientRect();
    const neighbourRect = neighbourEl.getBoundingClientRect();
    const offset = neighbourRect.top - currentRect.top;

    if (Math.abs(offset) < 1) {
        updateFn();
        return;
    }

    // Apply the actual DOM update
    updateFn();

    // Apply the inverse offset so the viewer sees no abrupt change yet
    inner.style.transition = 'none';
    inner.style.transform  = `translateY(${offset}px)`;

    // Force a layout flush
    inner.getBoundingClientRect(); 

    // Animate back to natural position
    const durationMs = Math.round(600 / Math.max(0.1, pixelScrollSpeed || 1.0));

    isAnimating = true;
    inner.style.transition = `transform ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
    inner.style.transform  = 'translateY(0)';

    const cleanup = (e) => {
        // FIX 1: Ignore bubbling transitionend events from child .lyric-line elements
        if (e && e.target !== inner) return;

        inner.removeEventListener('transitionend', cleanup);
        inner.style.transition = '';
        inner.style.transform  = '';
        isAnimating = false;

        // Process queued lines
        if (pendingCalls.length > 0) {
            // If the user skipped far ahead, instantly execute intermediate lines to catch up
            while (pendingCalls.length > 1) {
                pendingCalls.shift().updateFn();
            }
            const next = pendingCalls.shift();
            animatePixelScroll(next.updateFn, next.isForward);
        }
    };

    inner.addEventListener('transitionend', cleanup);
    // Fallback using an anonymous function so 'e' is undefined, safely bypassing the target check
    setTimeout(() => cleanup(), durationMs + 150); 
}