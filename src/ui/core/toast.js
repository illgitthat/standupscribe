/**
 * Global toast notification — drop-in replacement for per-page message banners.
 *
 *   import { showToast } from "../core/toast.js";
 *   showToast("Room deleted.");
 */

let toastEl = null;
let hideTimeoutId = 0;
let removeTimeoutId = 0;

function ensureToastElement() {
    if (toastEl) {
        return toastEl;
    }

    const portal = document.getElementById("portal-root");
    if (!portal) {
        return null;
    }

    toastEl = document.createElement("div");
    toastEl.className = "rr-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    toastEl.hidden = true;
    portal.appendChild(toastEl);
    return toastEl;
}

export function showToast(message) {
    const el = ensureToastElement();
    if (!el) {
        return;
    }

    el.textContent = message;
    el.hidden = false;
    el.classList.remove("rr-toast--hiding");

    // Force reflow so the entrance animation replays on rapid successive calls.
    el.style.animation = "none";
    void el.offsetHeight;
    el.style.animation = "";

    window.clearTimeout(hideTimeoutId);
    window.clearTimeout(removeTimeoutId);

    hideTimeoutId = window.setTimeout(() => {
        el.classList.add("rr-toast--hiding");
        removeTimeoutId = window.setTimeout(() => {
            el.hidden = true;
            el.classList.remove("rr-toast--hiding");
        }, 300);
    }, 1800);
}
