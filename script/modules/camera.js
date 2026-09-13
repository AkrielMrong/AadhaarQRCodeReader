/**
 * @module modules/camera
 * @description Camera access, real-time QR scanning loop, and file-upload QR
 * detection for the Aadhaar QR Code Reader app.
 *
 * Implements a multi-tiered decoding architecture:
 * 1. Native `window.BarcodeDetector` (hardware-accelerated ML Kit on Android Chrome)
 * 2. WebAssembly ZBar (`window.zbarWasm`, reference C barcode engine compiled to WASM)
 * 3. `jsQR` with adaptive contrast enhancement fallback
 *
 * The module exposes two public functions:
 * - {@link createCameraController} — creates a stateful camera controller object.
 * - {@link handleFileUpload} — reads a user-selected image file and scans it for
 *   a QR code in one shot.
 */

// ─── Helpers: Contrast enhancement ──────────────────────────────────────────

/**
 * Enhances contrast of an RGBA image buffer to assist decoders on low-contrast
 * or glare-affected scans (e.g. photos of Aadhaar cards).
 *
 * @param {Uint8ClampedArray} data - RGBA pixel array
 * @param {number} factor - Contrast multiplier (e.g. 1.5 - 2.0)
 * @returns {Uint8ClampedArray} New enhanced RGBA buffer
 */
function enhanceContrast(data, factor = 1.6) {
    const output = new Uint8ClampedArray(data.length);
    let minLum = 255;
    let maxLum = 0;

    // First pass: find luminance range
    for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
    }

    const mid = (minLum + maxLum) / 2;

    // Second pass: apply contrast stretch around mid-tone
    for (let i = 0; i < data.length; i += 4) {
        output[i]     = Math.min(255, Math.max(0, ((data[i]     - mid) * factor) + mid));
        output[i + 1] = Math.min(255, Math.max(0, ((data[i + 1] - mid) * factor) + mid));
        output[i + 2] = Math.min(255, Math.max(0, ((data[i + 2] - mid) * factor) + mid));
        output[i + 3] = data[i + 3]; // Preserve alpha
    }

    return output;
}

// ─── Native BarcodeDetector Cache ────────────────────────────────────────────

let nativeDetectorInstance = null;
let nativeDetectorChecked = false;

/**
 * Lazily creates and returns a native BarcodeDetector if supported by the browser.
 * @returns {Promise<BarcodeDetector | null>}
 */
async function getNativeDetector() {
    if (nativeDetectorChecked) return nativeDetectorInstance;
    nativeDetectorChecked = true;

    if (typeof window !== "undefined" && "BarcodeDetector" in window) {
        try {
            const formats = await window.BarcodeDetector.getSupportedFormats();
            if (formats.includes("qr_code")) {
                nativeDetectorInstance = new window.BarcodeDetector({ formats: ["qr_code"] });
            }
        } catch (err) {
            console.warn("BarcodeDetector initialization failed:", err);
            nativeDetectorInstance = null;
        }
    }
    return nativeDetectorInstance;
}

// ─── Camera controller ────────────────────────────────────────────────────────

/**
 * Creates and returns a stateful camera controller for continuous QR scanning.
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

    /** Guard to prevent overlapping frame processing. */
    let isProcessing = false;

    /** Timestamp of last scan to throttle non-hardware frame processing. */
    let lastScanTime = 0;

    /**
     * Starts camera with ideal 1080p resolution for high-density Aadhaar QR codes.
     */
    async function startCamera() {
        stopCamera();
        onStatus("Requesting camera...", "active");

        try {
            const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
            const constraints = {
                video: {
                    facingMode: isMobile ? { ideal: "environment" } : "user",
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
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

    /**
     * Stops the scan loop and releases media tracks.
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
        isProcessing = false;
    }

    /**
     * Switches between front and rear cameras.
     */
    async function switchCamera() {
        facingMode = facingMode === "environment" ? "user" : "environment";
        stopCamera();

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: facingMode },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
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

    /**
     * QR scan loop with multi-tier detection:
     * 1. Native BarcodeDetector directly on <video> (hardware-accelerated, < 15ms)
     * 2. WebAssembly ZBar on canvas frame (high-density QR specialist)
     * 3. jsQR fallback
     */
    async function scanLoop() {
        if (!scanning) return;

        const now = performance.now();
        const nativeDetector = await getNativeDetector();

        // Throttle processing if not using native detector to preserve battery and UI responsiveness
        const throttleInterval = nativeDetector ? 50 : 120;

        if (!isProcessing && video.readyState >= video.HAVE_ENOUGH_DATA && (now - lastScanTime >= throttleInterval)) {
            isProcessing = true;
            lastScanTime = now;

            try {
                let detectedData = null;

                // ── 1. Native BarcodeDetector (Zero-copy on <video>) ──
                if (nativeDetector) {
                    try {
                        const barcodes = await nativeDetector.detect(video);
                        if (barcodes && barcodes.length > 0) {
                            const val = barcodes[0].rawValue || barcodes[0].rawData;
                            if (val && val.trim()) {
                                detectedData = val.trim();
                            }
                        }
                    } catch (e) {
                        // Pass through to WASM fallback
                    }
                }

                // ── 2. Canvas-based scan (WASM ZBar / jsQR) ──
                if (!detectedData && video.videoWidth && video.videoHeight) {
                    const vw = video.videoWidth;
                    const vh = video.videoHeight;

                    // Aadhaar QRs require high resolution. We scan the central square at max density.
                    const size = Math.min(vw, vh);
                    canvas.width = size;
                    canvas.height = size;

                    const ctx = canvas.getContext("2d", { willReadFrequently: true });
                    const ox = (vw - size) / 2;
                    const oy = (vh - size) / 2;
                    ctx.drawImage(video, ox, oy, size, size, 0, 0, size, size);

                    const imgData = ctx.getImageData(0, 0, size, size);

                    // Try WASM ZBar first (handles Version 30+ dense QRs)
                    if (window.zbarWasm && typeof window.zbarWasm.scanImageData === "function") {
                        try {
                            const symbols = await window.zbarWasm.scanImageData(imgData);
                            if (symbols && symbols.length > 0) {
                                const text = symbols[0].decode();
                                if (text && text.trim()) {
                                    detectedData = text.trim();
                                }
                            }
                        } catch (e) {
                            // WASM scan error
                        }
                    }

                    // Try jsQR fallback
                    if (!detectedData && typeof jsQR === "function") {
                        const code = jsQR(imgData.data, imgData.width, imgData.height, {
                            inversionAttempts: "dontInvert",
                        });
                        if (code && code.data && code.data.trim()) {
                            detectedData = code.data.trim();
                        }
                    }
                }

                if (detectedData) {
                    scanning = false;
                    onStatus("QR detected! Decoding...", "active");
                    onQrDetected(detectedData);
                    return;
                }
            } catch (err) {
                console.warn("Scan loop error:", err);
            } finally {
                isProcessing = false;
            }
        }

        if (scanning) {
            animFrame = requestAnimationFrame(scanLoop);
        }
    }

    return { startCamera, stopCamera, switchCamera };
}

// ─── File upload ──────────────────────────────────────────────────────────────

/**
 * Handles image file upload with multi-tier detection & contrast enhancement.
 *
 * Scans the user image using:
 * 1. Native `BarcodeDetector` on Image element
 * 2. WebAssembly ZBar on full resolution ImageData
 * 3. ZBar on contrast-enhanced ImageData (recovers low-contrast / glare photos)
 * 4. `jsQR` on raw and enhanced ImageData
 *
 * @param {Event} event - The `change` event from `<input type="file">`.
 * @param {FileUploadOptions} options
 * @returns {void}
 */
export function handleFileUpload(event, { canvas, onQrDetected, onStatus, onPlaceholderHide }) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    onStatus("Reading image...", "active");

    const img = new window.Image();
    const url = URL.createObjectURL(file);

    img.onload = async () => {
        try {
            onStatus("Scanning image for Aadhaar QR code...", "active");

            // ── Tier 1: Native BarcodeDetector ──
            const nativeDetector = await getNativeDetector();
            if (nativeDetector) {
                try {
                    const barcodes = await nativeDetector.detect(img);
                    if (barcodes && barcodes.length > 0) {
                        const val = barcodes[0].rawValue || barcodes[0].rawData;
                        if (val && val.trim()) {
                            onSuccess(val.trim());
                            return;
                        }
                    }
                } catch (e) {
                    console.warn("Native BarcodeDetector on file upload failed:", e);
                }
            }

            // Draw image to canvas at full natural resolution
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);

            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            // ── Tier 2: WASM ZBar on raw ImageData ──
            if (window.zbarWasm && typeof window.zbarWasm.scanImageData === "function") {
                try {
                    const symbols = await window.zbarWasm.scanImageData(imgData);
                    if (symbols && symbols.length > 0) {
                        const text = symbols[0].decode();
                        if (text && text.trim()) {
                            onSuccess(text.trim());
                            return;
                        }
                    }
                } catch (e) {
                    console.warn("WASM ZBar raw scan failed:", e);
                }
            }

            // ── Tier 3: jsQR on raw ImageData ──
            if (typeof jsQR === "function") {
                const code = jsQR(imgData.data, imgData.width, imgData.height, {
                    inversionAttempts: "attemptBoth",
                });
                if (code && code.data && code.data.trim()) {
                    onSuccess(code.data.trim());
                    return;
                }
            }

            // ── Tier 4: Contrast-enhanced pass (crucial for photos with shadows/glare) ──
            onStatus("Enhancing contrast & re-scanning...", "active");
            const enhancedData = enhanceContrast(imgData.data, 1.6);

            // Try ZBar WASM on enhanced buffer
            if (window.zbarWasm && typeof window.zbarWasm.scanRGBABuffer === "function") {
                try {
                    const symbols = await window.zbarWasm.scanRGBABuffer(
                        enhancedData,
                        imgData.width,
                        imgData.height
                    );
                    if (symbols && symbols.length > 0) {
                        const text = symbols[0].decode();
                        if (text && text.trim()) {
                            onSuccess(text.trim());
                            return;
                        }
                    }
                } catch (e) {
                    console.warn("WASM ZBar enhanced scan failed:", e);
                }
            }

            // Try jsQR on enhanced buffer
            if (typeof jsQR === "function") {
                const code = jsQR(enhancedData, imgData.width, imgData.height, {
                    inversionAttempts: "attemptBoth",
                });
                if (code && code.data && code.data.trim()) {
                    onSuccess(code.data.trim());
                    return;
                }
            }

            onStatus("No QR code found in image. Please ensure the QR is clear and well-lit.", "error");
        } catch (err) {
            console.error("File upload processing error:", err);
            onStatus("Error reading image: " + err.message, "error");
        } finally {
            URL.revokeObjectURL(url);
            event.target.value = "";
        }
    };

    img.onerror = () => {
        URL.revokeObjectURL(url);
        onStatus("Could not load image file", "error");
        event.target.value = "";
    };

    img.src = url;

    function onSuccess(data) {
        URL.revokeObjectURL(url);
        event.target.value = "";
        onPlaceholderHide();
        onQrDetected(data);
    }
}
