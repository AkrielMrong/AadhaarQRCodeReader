/**
 * @module utils/dom
 * @description Lightweight DOM helpers for updating status-indicator UI elements.
 * All functions query the document by element ID and silently no-op when an
 * element is absent, making them safe to call in any page context.
 */

/**
 * Updates the status bar text and its accompanying visual dot indicator.
 *
 * Targets two elements by ID:
 * - `#status-text` — receives the human-readable message as `textContent`.
 * - `#dot` — receives a CSS class matching the `type` argument so the dot
 *   changes colour (green for `"active"` / `"success"`, red for `"error"`).
 *
 * @param {string} msg - Human-readable status message to display.
 * @param {"active" | "error" | "success"} [type] - Visual state for the dot.
 *   Omit (or pass `undefined`) to reset the dot to its default idle style.
 * @returns {void}
 *
 * @example
 * setStatus("Scanning… point at Aadhaar QR code", "active");
 * setStatus("QR verified successfully", "success");
 * setStatus("Camera error: permission denied", "error");
 */
export function setStatus(msg, type) {
    const statusText = document.getElementById("status-text");
    const dot = document.getElementById("dot");
    if (statusText) statusText.textContent = msg;
    if (dot) dot.className = "dot" + (type ? " " + type : "");
}
