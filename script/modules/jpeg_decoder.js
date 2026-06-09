/**
 * @module modules/jpeg_decoder
 * @description JPEG 2000 image decoding using the globally loaded `openjpeg`
 * Emscripten library (included via CDN in `index.html`).
 *
 * JPEG 2000 (ISO/IEC 15444-1) is the image format embedded inside Aadhaar
 * Secure QR payloads for the cardholder's photo. Standard browser `<img>` and
 * Canvas APIs do not support JP2/J2K natively, so this module bridges the gap
 * by routing the raw bytes through the WebAssembly-compiled openjpeg decoder.
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Polls for the `openjpeg` global function to become available, which is set
 * asynchronously by the Emscripten runtime after the WASM module initialises.
 *
 * The check is repeated every 50 ms. If the library has not initialised within
 * `timeoutMs` milliseconds the returned promise rejects so callers can surface
 * a meaningful error rather than waiting indefinitely.
 *
 * @param {number} [timeoutMs=6000] - Maximum time to wait for the library, in
 *   milliseconds.
 * @returns {Promise<void>} Resolves once `openjpeg` is a callable function.
 * @throws {Error} If the library does not load within `timeoutMs` ms.
 */
function waitForOpenJpeg(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (typeof openjpeg === "function") {
                resolve();
                return;
            }
            if (Date.now() - start > timeoutMs) {
                reject(new Error("OpenJPEG library failed to load"));
                return;
            }
            setTimeout(tick, 50);
        };
        tick();
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DecodedImage
 * @property {string} data   - PNG data-URL of the decoded image
 *   (`"data:image/png;base64,…"`), ready to set as `img.src`.
 * @property {string} width  - CSS pixel width of the upscaled image,
 *   e.g. `"120px"`.
 * @property {string} height - CSS pixel height of the upscaled image,
 *   e.g. `"152px"`.
 */

/**
 * Decodes a raw JPEG 2000 codestream and returns it as a PNG data-URL.
 *
 * ### Process
 * 1. Waits for the openjpeg WASM runtime to initialise.
 * 2. Detects whether the bytes are a raw J2K codestream (`FF 4F` magic) or a
 *    JP2 file-format container (`FF 50` / other), and passes the appropriate
 *    codec hint to openjpeg.
 * 3. Writes the decoded RGB planes onto an off-screen `<canvas>` as RGBA
 *    pixel data (alpha always fully opaque).
 * 4. Scales the canvas up by the largest integer factor that keeps both
 *    dimensions ≤ 460 px (capped at 6×) so small passport-size photos
 *    appear crisp on high-DPI displays.
 * 5. Exports the result as a PNG data-URL via `HTMLCanvasElement.toDataURL`.
 *
 * @param {Uint8Array | null | undefined} imageBytes - Raw JPEG 2000 bytes
 *   extracted from the Aadhaar QR payload. Returns `null` immediately if
 *   this is falsy or empty.
 * @returns {Promise<DecodedImage | null>} Resolves with a {@link DecodedImage}
 *   object, or `null` if `imageBytes` is empty.
 * @throws {Error} If the openjpeg library fails to load or reports a decode
 *   error.
 *
 * @example
 * const img = await decodeJp2Image(userData.imageBytes);
 * if (img) photoEl.src = img.data;
 */
export async function decodeJp2Image(imageBytes) {
    if (!imageBytes || !imageBytes.length) {
        return null;
    }

    await waitForOpenJpeg();

    // openjpeg expects a plain JS Array, not a typed array.
    const arr = Array.from(imageBytes);

    // A raw J2K codestream starts with the SOC marker FF 4F.
    // Everything else is treated as a JP2 file-format container.
    const suffix =
        imageBytes[0] === 0xff && imageBytes[1] === 0x4f ? "j2k" : "jp2";

    const result = openjpeg(arr, suffix);
    if (!result || result.error) {
        throw new Error(result ? result.error : "openjpeg returned null");
    }

    const { width, height, data } = result;

    // openjpeg returns three separate planar arrays (R, G, B), each of
    // `width × height` values. We interleave them into RGBA ImageData.
    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;

    const ctx = offscreen.getContext("2d");
    const imgData = ctx.createImageData(width, height);
    const pixels = imgData.data;
    const plane = width * height;

    for (let i = 0; i < plane; i++) {
        pixels[i * 4]     = data[i];           // R
        pixels[i * 4 + 1] = data[plane + i];   // G
        pixels[i * 4 + 2] = data[2 * plane + i]; // B
        pixels[i * 4 + 3] = 255;               // A (fully opaque)
    }

    ctx.putImageData(imgData, 0, 0);

    // Integer upscale so small QR photos look crisp on retina screens.
    const scale = Math.max(1, Math.min(6, Math.floor(460 / Math.max(width, height))));
    return {
        data: offscreen.toDataURL("image/png"),
        width: `${width * scale}px`,
        height: `${height * scale}px`,
    };
}
