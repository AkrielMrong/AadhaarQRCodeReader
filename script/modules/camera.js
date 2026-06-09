/**
 * @module modules/camera
 * @description Camera access, real-time QR scanning loop, and file-upload QR
 * detection for the Aadhaar QR Code Reader app.
 *
 * The module exposes two public functions:
 * - {@link createCameraController} — creates a stateful camera controller object.
 * - {@link handleFileUpload} — reads a user-selected image file and scans it for
 *   a QR code in one shot.
 *
 * Both functions delegate QR decoding to the globally loaded `jsQR` library
 * (loaded via CDN in `index.html`).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CameraController
 * @property {() => Promise<boolean>} startCamera  - Requests camera permission,
 *   starts the video stream, and begins the scan loop. Resolves `true` on
 *   success, `false` on error.
 * @property {() => void}             stopCamera   - Stops all active media
 *   tracks and cancels the scan loop.
 * @property {() => Promise<void>}    switchCamera - Toggles between front and
 *   rear cameras and restarts the scan loop.
 */

/**
 * @typedef {Object} CameraControllerOptions
 * @property {HTMLVideoElement}  video         - `<video>` element used to
 *   display the live camera feed.
 * @property {HTMLCanvasElement} canvas        - Off-screen `<canvas>` used to
 *   capture individual frames for QR analysis.
 * @property {(data: string) => void} onQrDetected - Callback invoked with the
 *   raw QR string as soon as a code is successfully decoded.
 * @property {(msg: string, type?: string) => void} onStatus - Callback used to
 *   report status messages and dot-indicator state changes to the UI.
 */

/**
 * @typedef {Object} FileUploadOptions
 * @property {HTMLCanvasElement} canvas           - Canvas used to rasterise the
 *   uploaded image for QR scanning.
 * @property {(data: string) => void} onQrDetected - Called with the raw QR
 *   string when a code is found.
 * @property {(msg: string, type?: string) => void} onStatus - UI status
 *   callback (same contract as in {@link CameraControllerOptions}).
 * @property {() => void} onPlaceholderHide       - Called just before
 *   `onQrDetected` so the caller can hide any placeholder UI.
 */

// ─── Camera controller ────────────────────────────────────────────────────────

/**
 * Creates and returns a stateful camera controller for continuous QR scanning.
 *
 * Internally the controller keeps track of the active `MediaStream`, the
 * current `facingMode`, and a `requestAnimationFrame` handle for the scan loop.
 * All state is encapsulated — callers interact only through the returned
 * {@link CameraController} object.
 *
 * ### Usage
 * ```js
 * const camera = createCameraController({
 *   video, canvas, onQrDetected: handleQR, onStatus: setStatus,
 * });
 * await camera.startCamera();
 * ```
 *
 * @param {CameraControllerOptions} options
 * @returns {CameraController}
 */
export function createCameraController({ video, canvas, onQrDetected, onStatus }) {
    /** @type {MediaStream | null} */
    let stream = null;

    /** @type {"environment" | "user"} Active camera direction. */
    let facingMode = "environment";

    /** @type {boolean} Whether the scan loop should keep running. */
    let scanning = false;

    /** @type {number | null} `requestAnimationFrame` handle for the scan loop. */
    let animFrame = null;

    // ── Public: startCamera ────────────────────────────────────────────────

    /**
     * Requests camera access, attaches the stream to the `<video>` element,
     * and starts the QR scan loop.
     *
     * On mobile devices the rear (`environment`) camera is preferred; on
     * desktops the front (`user`) camera is used as it is typically the only
     * one available.
     *
     * @returns {Promise<boolean>} `true` if the camera started successfully,
     *   `false` if the user denied permission or an error occurred.
     */
    async function startCamera() {
        stopCamera();
        onStatus("Requesting camera...", "active");

        try {
            const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
            const constraints = {
                video: {
                    facingMode: isMobile ? { ideal: "environment" } : "user",
                    width: { ideal: 1280 },
                    height: { ideal: 1280 },
                },
            };

            stream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            await video.play();

            scanning = true;
            onStatus("Scanning... point at Aadhaar QR code", "active");
            scanLoop();
            return true;
        } catch (e) {
            onStatus("Camera error: " + e.message, "error");
            return false;
        }
    }

    // ── Public: stopCamera ────────────────────────────────────────────────

    /**
     * Stops the scan loop and releases all camera tracks.
     *
     * Safe to call even when the camera is already stopped — all state is
     * reset to its initial values.
     *
     * @returns {void}
     */
    function stopCamera() {
        scanning = false;
        if (animFrame) {
            cancelAnimationFrame(animFrame);
            animFrame = null;
        }

        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
        }

        video.srcObject = null;
    }

    // ── Public: switchCamera ──────────────────────────────────────────────

    /**
     * Toggles between the front (`user`) and rear (`environment`) camera and
     * restarts the scan loop on the new device.
     *
     * If the new camera cannot be opened the status indicator is updated with
     * the error message and the scan loop is not restarted.
     *
     * @returns {Promise<void>}
     */
    async function switchCamera() {
        facingMode = facingMode === "environment" ? "user" : "environment";
        stopCamera();

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: facingMode } },
            });
            video.srcObject = stream;
            await video.play();
            scanning = true;
            scanLoop();
            onStatus("Scanning... point at Aadhaar QR code", "active");
        } catch (e) {
            onStatus("Switch failed: " + e.message, "error");
        }
    }

    // ── Private: scanLoop ─────────────────────────────────────────────────

    /**
     * Recursive `requestAnimationFrame` loop that captures a square-cropped
     * frame from the video feed on each tick and passes it to `jsQR` for
     * analysis.
     *
     * The frame is cropped to a centre square (the smaller of videoWidth /
     * videoHeight) so that the aspect ratio matches a typical QR target area.
     * Once a QR code is found the loop stops and `onQrDetected` is called.
     *
     * @returns {void}
     */
    function scanLoop() {
        if (!scanning) return;

        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            const size = Math.min(video.videoWidth, video.videoHeight);
            canvas.width = size;
            canvas.height = size;

            const ctx = canvas.getContext("2d");
            const ox = (video.videoWidth - size) / 2;
            const oy = (video.videoHeight - size) / 2;
            ctx.drawImage(video, ox, oy, size, size, 0, 0, size, size);

            const imgData = ctx.getImageData(0, 0, size, size);
            const code = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: "dontInvert",
            });

            if (code && code.data) {
                scanning = false;
                onStatus("QR detected! Decoding...", "active");
                onQrDetected(code.data.trim());
                return;
            }
        }

        animFrame = requestAnimationFrame(scanLoop);
    }

    return { startCamera, stopCamera, switchCamera };
}

// ─── File upload ──────────────────────────────────────────────────────────────

/**
 * Handles a file-input `change` event by reading the selected image, drawing
 * it onto a canvas, and running `jsQR` over the full image in a single pass.
 *
 * The object URL created for the image is revoked immediately after the image
 * loads (success or failure) to avoid memory leaks. The file-input value is
 * also cleared so the same file can be re-selected if needed.
 *
 * @param {Event} event - The `change` event from the `<input type="file">`.
 * @param {FileUploadOptions} options
 * @returns {void}
 *
 * @example
 * fileInput.addEventListener("change", event =>
 *   handleFileUpload(event, { canvas, onQrDetected, onStatus, onPlaceholderHide })
 * );
 */
export function handleFileUpload(event, { canvas, onQrDetected, onStatus, onPlaceholderHide }) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    onStatus("Reading image...", "active");

    const img = new window.Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height, {
            inversionAttempts: "attemptBoth",
        });

        URL.revokeObjectURL(url);
        event.target.value = "";

        if (code && code.data) {
            onPlaceholderHide();
            onQrDetected(code.data.trim());
        } else {
            onStatus("No QR code found in image", "error");
        }
    };

    img.onerror = () => {
        URL.revokeObjectURL(url);
        onStatus("Could not load image", "error");
    };

    img.src = url;
}
