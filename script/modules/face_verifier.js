/**
 * @module modules/face_verifier
 * @description Client-side controller for 1:1 Face Verification against
 * the Python InsightFace ArcFace verification backend.
 */

export const CLOUDFLARE_TUNNEL_URL = "https://sscf.qzz.io";
export const LOCAL_SERVER_URL = "http://localhost:8000";

/**
 * Gets the configured or default InsightFace server URL.
 * Automatically selects the HTTPS Cloudflare Tunnel URL when loaded on HTTPS (e.g. GitHub Pages)
 * to avoid browser mixed-content restrictions.
 *
 * @returns {string}
 */
export function getServerUrl() {
    if (typeof window === "undefined") return LOCAL_SERVER_URL;

    const custom = localStorage.getItem("aadhaar_insightface_url");
    if (custom && custom.trim()) {
        return custom.trim().replace(/\/+$/, "");
    }

    // If loaded on HTTPS (e.g. GitHub Pages), use the Cloudflare HTTPS Tunnel
    if (window.location.protocol === "https:") {
        return CLOUDFLARE_TUNNEL_URL;
    }

    // Default to localhost:8000 on plain HTTP
    return LOCAL_SERVER_URL;
}

/**
 * Saves or clears the user-specified server URL.
 * @param {string} [url]
 */
export function setServerUrl(url) {
    if (typeof window === "undefined") return;
    if (url && url.trim()) {
        localStorage.setItem("aadhaar_insightface_url", url.trim().replace(/\/+$/, ""));
    } else {
        localStorage.removeItem("aadhaar_insightface_url");
    }
}

/**
 * Checks if the InsightFace backend server is reachable and healthy.
 *
 * @param {string} [serverUrl]
 * @returns {Promise<{ available: boolean, engine?: string, error?: string, url: string }>}
 */
export async function checkServerHealth(serverUrl = getServerUrl()) {
    try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3500);
        const resp = await fetch(`${serverUrl}/health`, { signal: ctrl.signal });
        clearTimeout(timeout);
        if (resp.ok) {
            const data = await resp.json();
            return { available: true, engine: data.engine, url: serverUrl };
        }
        return { available: false, error: `HTTP ${resp.status}`, url: serverUrl };
    } catch (err) {
        return { available: false, error: err.message, url: serverUrl };
    }
}

/**
 * Starts the front-facing (selfie) camera.
 *
 * @param {HTMLVideoElement} videoElem
 * @returns {Promise<MediaStream>}
 */
export async function startSelfieCamera(videoElem) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API is not supported in this browser environment");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 640 },
        },
        audio: false,
    });

    videoElem.srcObject = stream;
    await videoElem.play();
    return stream;
}

/**
 * Stops all media tracks on a camera stream.
 *
 * @param {MediaStream|null} stream
 */
export function stopSelfieCamera(stream) {
    if (!stream) return;
    try {
        stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
        console.warn("Could not stop selfie track:", err);
    }
}

/**
 * Captures the current video frame onto an offscreen canvas and returns a JPEG Data URI.
 *
 * @param {HTMLVideoElement} videoElem
 * @returns {string} Base64 data-URI image
 */
export function captureVideoFrame(videoElem) {
    const w = videoElem.videoWidth || 640;
    const h = videoElem.videoHeight || 480;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    // Mirror horizontally for selfie camera natural feel
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoElem, 0, 0, w, h);

    return canvas.toDataURL("image/jpeg", 0.92);
}

/**
 * Sends both images to the InsightFace verification server.
 *
 * @param {Object} params
 * @param {string} params.aadhaarImage - Base64 data-uri of Aadhaar photo.
 * @param {string} params.liveImage - Base64 data-uri of live selfie.
 * @param {string} [params.serverUrl] - URL of InsightFace backend.
 * @param {number} [params.threshold=0.40] - Matching threshold.
 * @returns {Promise<Object>} Verification result from InsightFace.
 */
export async function verifyFaceWithServer({
    aadhaarImage,
    liveImage,
    serverUrl = getServerUrl(),
    threshold = 0.40,
}) {
    const resp = await fetch(`${serverUrl}/api/verify`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            aadhaar_image: aadhaarImage,
            live_image: liveImage,
            threshold,
        }),
    });

    if (!resp.ok) {
        let errMsg = `Server error ${resp.status}`;
        try {
            const errData = await resp.json();
            if (errData.detail) errMsg = errData.detail;
        } catch (_) {}
        throw new Error(errMsg);
    }

    return await resp.json();
}
