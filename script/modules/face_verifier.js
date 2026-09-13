/**
 * @module modules/face_verifier
 * @description Client-side controller for 1:1 Face Verification against
 * the Python InsightFace ArcFace verification backend.
 */

const DEFAULT_SERVER_URL = "http://localhost:8000";

/**
 * Checks if the InsightFace backend server is reachable and healthy.
 *
 * @param {string} [serverUrl=DEFAULT_SERVER_URL]
 * @returns {Promise<{ available: boolean, engine?: string, error?: string }>}
 */
export async function checkServerHealth(serverUrl = DEFAULT_SERVER_URL) {
    try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 2500);
        const resp = await fetch(`${serverUrl}/health`, { signal: ctrl.signal });
        clearTimeout(timeout);
        if (resp.ok) {
            const data = await resp.json();
            return { available: true, engine: data.engine };
        }
        return { available: false, error: `HTTP ${resp.status}` };
    } catch (err) {
        return { available: false, error: err.message };
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
 * @param {string} [params.serverUrl=DEFAULT_SERVER_URL] - URL of InsightFace backend.
 * @param {number} [params.threshold=0.40] - Matching threshold.
 * @returns {Promise<Object>} Verification result from InsightFace.
 */
export async function verifyFaceWithServer({
    aadhaarImage,
    liveImage,
    serverUrl = DEFAULT_SERVER_URL,
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
