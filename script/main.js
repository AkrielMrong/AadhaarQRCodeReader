/**
 * @file main.js
 * @description Application entry point for the Aadhaar QR Code Reader.
 *
 * Responsibilities:
 * - Bootstraps the camera controller and wires all DOM event listeners.
 * - On QR detection, redirects to `?data=<encoded-qr>` so the result URL is
 *   shareable and the browser back-button returns to the scanner naturally.
 * - On page load with a `?data=` param, decodes the payload and renders the
 *   verified Aadhaar card result without opening the camera.
 *
 * Module graph:
 * ```
 * main.js
 *  ├── modules/aadhaar.js       — Aadhaar QR payload decoding
 *  ├── modules/jpeg_decoder.js  — JPEG 2000 photo decoding
 *  ├── modules/camera.js        — Camera controller & file-upload QR scan
 *  ├── utils/dom.js             — setStatus (status bar helper)
 *  └── utils/format.js          — formatAadhaarNumber, extractComment
 * ```
 */

import { decodeAadhaarQR } from "./modules/aadhaar.js";
import { decodeJp2Image } from "./modules/jpeg_decoder.js";
import { createCameraController, handleFileUpload } from "./modules/camera.js";
import {
    checkServerHealth,
    startSelfieCamera,
    stopSelfieCamera,
    captureVideoFrame,
    verifyFaceWithServer,
    getServerUrl,
    setServerUrl,
} from "./modules/face_verifier.js";
import { setStatus } from "./utils/dom.js";
import { extractComment, formatAadhaarNumber } from "./utils/format.js";

// ─── DOM references ───────────────────────────────────────────────────────────

/**
 * Cached references to every DOM element the app needs to read or update.
 * Queried once at startup; individual properties are `null` when the element
 * is absent from the page.
 *
 * @type {{
 *   scannerSection: HTMLElement | null,
 *   resultSection:  HTMLElement | null,
 *   placeholder:    HTMLElement | null,
 *   video:          HTMLVideoElement | null,
 *   canvas:         HTMLCanvasElement | null,
 *   fileInput:      HTMLInputElement | null,
 *   btnStart:       HTMLButtonElement | null,
 *   btnSwitch:      HTMLButtonElement | null,
 *   btnUpload:      HTMLButtonElement | null,
 *   cardRotor:      HTMLElement | null,
 *   flipCard:       HTMLElement | null,
 *   backToScanner:  HTMLButtonElement | null,
 *   flipButton:     HTMLButtonElement | null,
 *   frontFace:      HTMLElement | null,
 *   backFace:       HTMLElement | null,
 *   photo:          HTMLImageElement | null,
 *   nameEnglish:    HTMLElement | null,
 *   dob:            HTMLElement | null,
 *   gender:         HTMLElement | null,
 *   frontNumber:    HTMLElement | null,
 *   backNumber:     HTMLElement | null,
 *   addressEnglish: HTMLElement | null,
 *   mobile:         HTMLElement | null,
 *   emailRow:       HTMLElement | null,
 *   emailAddress:   HTMLElement | null,
 *   referenceDate:  HTMLElement | null,
 *   verifiedBadge:  HTMLElement | null,
 *   verifiedIcon:   HTMLImageElement | null,
 *   verifiedText:   HTMLElement | null,
 *   signerInfo:     HTMLElement | null,
 *   [key: string]:  any
 * }}
 */
const dom = {
    scannerSection: document.getElementById("scanner-section"),
    resultSection:  document.getElementById("result-section"),
    placeholder:    document.getElementById("placeholder"),
    video:          document.getElementById("video"),
    canvas:         document.getElementById("canvas"),
    fileInput:      document.getElementById("file-input"),
    btnStart:       document.getElementById("btn-start"),
    btnSwitch:      document.getElementById("btn-switch"),
    btnUpload:      document.getElementById("btn-upload"),
    cardRotor:      document.getElementById("card-rotor"),
    flipCard:       document.getElementById("flip-card"),
    backToScanner:  document.getElementById("back-to-scanner"),
    flipButton:     document.getElementById("flip-button"),
    frontFace:      document.getElementById("front-face"),
    backFace:       document.getElementById("back-face"),
    photo:          document.getElementById("photo"),
    nameEnglish:    document.getElementById("name-english"),
    dob:            document.getElementById("dob"),
    gender:         document.getElementById("gender"),
    frontNumber:    document.getElementById("front-number"),
    backNumber:     document.getElementById("back-number"),
    addressEnglish: document.getElementById("address-english"),
    mobile:         document.getElementById("mobile-number"),
    emailRow:       document.getElementById("email-row"),
    emailAddress:   document.getElementById("email-address"),
    referenceDate:  document.getElementById("reference-date"),
    verifiedBadge:  document.getElementById("verified-badge"),
    verifiedIcon:   document.getElementById("verified-icon"),
    verifiedText:   document.getElementById("verified-text"),
    signerInfo:     document.getElementById("signer-info"),

    // Face verification DOM elements
    faceVerifyCard:      document.getElementById("face-verify-card"),
    fvcBadge:            document.getElementById("fvc-badge"),
    fvcAadhaarImg:       document.getElementById("fvc-aadhaar-img"),
    fvcSelfieImg:        document.getElementById("fvc-selfie-img"),
    fvcEmptyPrompt:      document.getElementById("fvc-empty-prompt"),
    fvcCameraViewfinder: document.getElementById("fvc-camera-viewfinder"),
    fvcVideo:            document.getElementById("fvc-video"),
    btnSnapSelfie:       document.getElementById("btn-snap-selfie"),
    btnCancelSelfie:     document.getElementById("btn-cancel-selfie"),
    fvcMeterCard:        document.getElementById("fvc-meter-card"),
    fvcScoreText:        document.getElementById("fvc-score-text"),
    fvcConfidenceTag:    document.getElementById("fvc-confidence-tag"),
    fvcMeterBar:         document.getElementById("fvc-meter-bar"),
    fvcVerdict:          document.getElementById("fvc-verdict"),
    btnOpenSelfieCam:    document.getElementById("btn-open-selfie-cam"),
    btnUploadSelfie:     document.getElementById("btn-upload-selfie"),
    selfieFileInput:     document.getElementById("selfie-file-input"),
    fvcMainButtons:      document.getElementById("fvc-main-buttons"),
    fvcServerStatus:     document.getElementById("fvc-server-status"),
    fvcDot:              document.getElementById("fvc-dot"),
    fvcServerText:       document.getElementById("fvc-server-text"),
    btnConfigServer:     document.getElementById("btn-config-server"),
    fvcServerConfig:     document.getElementById("fvc-server-config"),
    fvcServerInput:      document.getElementById("fvc-server-input"),
    btnSaveServer:       document.getElementById("btn-save-server"),
    btnResetServer:      document.getElementById("btn-reset-server"),
};

/** Default photo `src` captured before any scan so it can be restored on reset. */
const defaultPhotoSrc = dom.photo ? dom.photo.src : "";

/** Shared camera controller instance. */
const camera = createCameraController({
    video:          dom.video,
    canvas:         dom.canvas,
    onQrDetected:   handleDetectedPayload,
    onStatus:       setStatus,
});

// ─── View helpers ─────────────────────────────────────────────────────────────

/**
 * Shows the scanner section and hides the result section.
 * Called when the user navigates back to scan a new QR code.
 *
 * @returns {void}
 */
function showScanner() {
    if (dom.scannerSection) dom.scannerSection.style.display = "";
    if (dom.resultSection)  dom.resultSection.classList.add("is-hidden");
}

/**
 * Shows the result section and hides the scanner section.
 * Called after a QR code has been successfully decoded and rendered.
 *
 * @returns {void}
 */
function showResultSection() {
    if (dom.scannerSection) dom.scannerSection.style.display = "none";
    if (dom.resultSection)  dom.resultSection.classList.remove("is-hidden");
}

/**
 * Resets the Aadhaar card 3D flip to its default orientation (front face
 * visible). Should be called before showing the result section so each
 * new scan always starts on the front face.
 *
 * @returns {void}
 */
function resetCardOrientation() {
    if (!dom.frontFace || !dom.backFace) return;
    dom.frontFace.style.transform = "rotateY(0deg)";
    dom.backFace.style.transform  = "rotateY(-180deg)";
}

// ─── Result rendering ─────────────────────────────────────────────────────────

/**
 * Populates the result card with decoded Aadhaar data and (optionally) the
 * embedded photo, then transitions the view to the result section.
 *
 * Address fields are joined with `", "` in the order they appear on the
 * physical card; empty / undefined parts are filtered out automatically.
 *
 * Photo decoding is attempted asynchronously via {@link decodeJp2Image}. A
 * failure is non-fatal — the default placeholder photo is shown instead.
 *
 * @param {import("./modules/aadhaar.js").AadhaarData} userData - Decoded
 *   Aadhaar fields returned by {@link decodeAadhaarQR}.
 * @returns {Promise<void>}
 */
async function renderResult(userData) {
    dom.nameEnglish.textContent = userData.name;
    dom.dob.textContent = userData.dob ? `DOB: ${userData.dob}` : "";
    dom.gender.textContent =
        userData.gender === "M"
            ? "Gender: Male"
            : userData.gender === "F"
              ? "Gender: Female"
              : userData.gender || "-";

    dom.addressEnglish.textContent =
        [
            userData.careof,
            userData.house,
            userData.street,
            userData.landmark,
            userData.location,
            userData.vtc,
            userData.postoffice,
            userData.subdistrict,
            userData.district,
            userData.state,
            userData.pincode,
        ]
            .filter(Boolean)
            .join(", ") || "-";

    const formattedNumber = formatAadhaarNumber(userData.aadhaar_num);
    dom.frontNumber.textContent = formattedNumber;
    dom.backNumber.textContent  = formattedNumber;
    dom.mobile.textContent      = userData.last_4_digits_mobile_no ?? "-";

    // Reference date — format as "24 May 2026" from the parsed Date object.
    if (userData.reference_date instanceof Date && !isNaN(userData.reference_date)) {
        dom.referenceDate.textContent = userData.reference_date.toISOString();
    }

    // Email — only surfaced when present in the QR payload.
    if (userData.email) {
        dom.emailAddress.textContent = userData.email;
        dom.emailRow.hidden = false;
    } else {
        dom.emailRow.hidden = true;
    }

    // Digital signature verification badge & cryptographic audit info
    if (userData.signatureResult && userData.signatureResult.isValid) {
        if (dom.verifiedBadge) {
            dom.verifiedBadge.className = "verified-badge verified-success";
        }
        if (dom.verifiedIcon) {
            dom.verifiedIcon.src = "./images/tick_mark_green.png";
            dom.verifiedIcon.alt = "UIDAI Verified";
        }
        if (dom.verifiedText) {
            dom.verifiedText.textContent = "UIDAI DIGITALLY VERIFIED";
        }
        if (dom.signerInfo) {
            dom.signerInfo.className = "signer-info";
            dom.signerInfo.textContent = `Offline verified: ${userData.signatureResult.signerName || "UIDAI"} (${userData.signatureResult.signerPeriod || "Official Certificate"})`;
            dom.signerInfo.style.display = "";
        }
    } else {
        if (dom.verifiedBadge) {
            dom.verifiedBadge.className = "verified-badge verified-danger";
        }
        if (dom.verifiedIcon) {
            dom.verifiedIcon.src = "./images/alert_icon_red.svg";
            dom.verifiedIcon.alt = "Signature Mismatch / Tampered";
        }
        if (dom.verifiedText) {
            dom.verifiedText.textContent = "SIGNATURE INVALID / TAMPERED";
        }
        if (dom.signerInfo) {
            dom.signerInfo.className = "signer-info danger";
            dom.signerInfo.textContent =
                userData.signatureResult?.error ||
                "WARNING: QR signature does not match UIDAI public keys. Data is forged or altered.";
            dom.signerInfo.style.display = "";
        }
    }

    // Reset to default photo while async decode runs.
    dom.photo.src = defaultPhotoSrc;
    let aadhaarPhotoBase64 = "";

    if (userData.imageBytes && userData.imageBytes.length) {
        console.log("Embedded comment: " + extractComment(userData.imageBytes));
        try {
            const photoData = await decodeJp2Image(userData.imageBytes);
            if (photoData && photoData.data) {
                dom.photo.src = photoData.data;
                aadhaarPhotoBase64 = photoData.data;
                if (dom.fvcAadhaarImg) dom.fvcAadhaarImg.src = photoData.data;
            }
        } catch (err) {
            console.warn("Photo decode failed:", err);
        }
    }

    resetFaceVerificationState(aadhaarPhotoBase64);
    resetCardOrientation();
    showResultSection();
}

// ─── QR detection handler ─────────────────────────────────────────────────────

/**
 * Entry point called by both the camera scan loop and the file-upload handler
 * whenever a raw QR string is detected.
 *
 * ### Redirect-then-render flow
 * If the QR was detected live (i.e. the URL does **not** already contain a
 * `?data=` parameter), the function redirects to the same path with the
 * encoded QR value appended. This makes the result URL shareable and gives
 * the browser back-button natural scanner ↔ result navigation.
 *
 * On the subsequent page load `init()` reads the `data` param and calls this
 * function again — this time the redirect is skipped and the payload is
 * decoded synchronously.
 *
 * @param {string} rawText - Raw string data from the detected QR code.
 * @returns {Promise<void>}
 */
async function handleDetectedPayload(rawText) {
    const safeText = (rawText || "").trim();
    if (!safeText) {
        setStatus("QR data is empty", "error");
        return;
    }

    try {
        if (dom.placeholder) dom.placeholder.style.display = "none";
        setStatus("Decoding Aadhaar details...", "active");

        const fields = await decodeAadhaarQR(safeText);
        await renderResult(fields);
        setStatus("QR verified successfully", "success");
        camera.stopCamera();

        // Update URL state without full page reload so result is shareable
        const params = new URLSearchParams(window.location.search);
        if (params.get("data") !== safeText) {
            try {
                history.pushState({ data: safeText }, "", "?data=" + encodeURIComponent(safeText));
            } catch (err) {
                console.warn("Could not update URL history:", err);
            }
        }
    } catch (e) {
        setStatus("Error: " + e.message, "error");
        console.error(e);
    } finally {
        if (dom.btnStart) dom.btnStart.disabled = false;
    }
}

// ─── Card flip ────────────────────────────────────────────────────────────────

/**
 * Toggles the Aadhaar card between its front (personal details) and back
 * (address) faces using CSS 3D `rotateY` transforms.
 *
 * No-ops if the result section is currently hidden.
 *
 * @returns {void}
 */
function flipCard() {
    if (!dom.resultSection || dom.resultSection.classList.contains("is-hidden")) {
        return;
    }

    if (dom.frontFace.style.transform.includes("180")) {
        dom.frontFace.style.transform = "rotateY(0deg)";
        dom.backFace.style.transform  = "rotateY(-180deg)";
    } else {
        dom.frontFace.style.transform = "rotateY(180deg)";
        dom.backFace.style.transform  = "rotateY(0deg)";
    }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

/**
 * Navigates back to the scanner smoothly without a full page reload.
 *
 * @returns {void}
 */
function scanAgain() {
    try {
        history.pushState({}, "", location.pathname);
    } catch (e) {
        location.replace(location.pathname);
        return;
    }
    camera.stopCamera();
    resetCardOrientation();
    showScanner();
    setStatus("Tap Start Camera to begin scanning");
}

window.addEventListener("popstate", () => {
    const params = new URLSearchParams(window.location.search);
    const data = params.get("data");
    if (data) {
        handleDetectedPayload(data);
    } else {
        camera.stopCamera();
        resetCardOrientation();
        showScanner();
        setStatus("Tap Start Camera to begin scanning");
    }
});

// ─── 1:1 InsightFace Verification Controllers ─────────────────────────────────

/** Holds the active selfie video stream. */
let selfieStream = null;
/** Holds the current decoded Aadhaar photo base64 data URI. */
let currentAadhaarPhoto = "";

/**
 * Resets the Face Verification card to its initial pending state.
 * @param {string} aadhaarPhoto
 */
function resetFaceVerificationState(aadhaarPhoto) {
    currentAadhaarPhoto = aadhaarPhoto;
    if (selfieStream) {
        stopSelfieCamera(selfieStream);
        selfieStream = null;
    }

    if (dom.fvcBadge) {
        dom.fvcBadge.className = "fvc-badge fvc-pending";
        dom.fvcBadge.textContent = "PENDING SELFIE";
    }

    if (dom.fvcSelfieImg) dom.fvcSelfieImg.style.display = "none";
    if (dom.fvcEmptyPrompt) dom.fvcEmptyPrompt.style.display = "";
    if (dom.fvcCameraViewfinder) dom.fvcCameraViewfinder.classList.add("is-hidden");
    if (dom.fvcMeterCard) dom.fvcMeterCard.classList.add("is-hidden");
    if (dom.fvcMainButtons) dom.fvcMainButtons.style.display = "";

    // Check InsightFace server health
    updateServerHealthIndicator();
}

/**
 * Pings the InsightFace backend server and updates the status indicator.
 */
async function updateServerHealthIndicator() {
    if (!dom.fvcServerText || !dom.fvcDot) return;
    dom.fvcDot.className = "fvc-dot";
    dom.fvcServerText.textContent = "Checking InsightFace server...";

    const currentUrl = getServerUrl();
    if (dom.fvcServerInput && !dom.fvcServerInput.value) {
        dom.fvcServerInput.value = currentUrl;
    }

    const health = await checkServerHealth(currentUrl);
    if (health.available) {
        dom.fvcDot.className = "fvc-dot online";
        dom.fvcServerText.textContent = `AI Server: Online (${currentUrl})`;
    } else {
        dom.fvcDot.className = "fvc-dot offline";
        dom.fvcServerText.textContent = `AI Server: Offline (${currentUrl})`;
    }
}

/**
 * Opens the front-facing selfie camera.
 */
async function openSelfieCamera() {
    if (!dom.fvcVideo || !dom.fvcCameraViewfinder) return;
    try {
        dom.fvcCameraViewfinder.classList.remove("is-hidden");
        if (dom.fvcMainButtons) dom.fvcMainButtons.style.display = "none";
        selfieStream = await startSelfieCamera(dom.fvcVideo);
    } catch (err) {
        alert("Camera error: " + err.message + "\nYou can also use the 'Upload Photo' button.");
        cancelSelfieCamera();
    }
}

/**
 * Cancels the selfie camera.
 */
function cancelSelfieCamera() {
    if (selfieStream) {
        stopSelfieCamera(selfieStream);
        selfieStream = null;
    }
    if (dom.fvcCameraViewfinder) dom.fvcCameraViewfinder.classList.add("is-hidden");
    if (dom.fvcMainButtons) dom.fvcMainButtons.style.display = "";
}

/**
 * Snaps a selfie from the video frame and verifies it.
 */
async function snapSelfie() {
    if (!dom.fvcVideo) return;
    const selfieDataUri = captureVideoFrame(dom.fvcVideo);
    cancelSelfieCamera();
    await verifySelfie(selfieDataUri);
}

/**
 * Compares the live selfie against the Aadhaar card photo using InsightFace.
 * @param {string} selfieDataUri
 */
async function verifySelfie(selfieDataUri) {
    if (!currentAadhaarPhoto) {
        alert("No Aadhaar resident photo was found in this QR code to compare against.");
        return;
    }

    if (dom.fvcSelfieImg) {
        dom.fvcSelfieImg.src = selfieDataUri;
        dom.fvcSelfieImg.style.display = "";
    }
    if (dom.fvcEmptyPrompt) dom.fvcEmptyPrompt.style.display = "none";

    if (dom.fvcBadge) {
        dom.fvcBadge.className = "fvc-badge fvc-verifying";
        dom.fvcBadge.textContent = "ANALYZING FACE...";
    }

    if (dom.fvcMeterCard) dom.fvcMeterCard.classList.remove("is-hidden");
    if (dom.fvcScoreText) dom.fvcScoreText.textContent = "Running InsightFace ArcFace neural network...";
    if (dom.fvcConfidenceTag) {
        dom.fvcConfidenceTag.className = "fvc-confidence-tag";
        dom.fvcConfidenceTag.textContent = "PROCESSING";
    }
    if (dom.fvcMeterBar) {
        dom.fvcMeterBar.className = "fvc-meter-bar";
        dom.fvcMeterBar.style.width = "40%";
    }
    if (dom.fvcVerdict) {
        dom.fvcVerdict.className = "fvc-verdict";
        dom.fvcVerdict.textContent = "Extracting 512-dimensional facial embeddings...";
    }

    try {
        const result = await verifyFaceWithServer({
            aadhaarImage: currentAadhaarPhoto,
            liveImage: selfieDataUri,
        });

        if (result.match) {
            if (dom.fvcBadge) {
                dom.fvcBadge.className = "fvc-badge fvc-match";
                dom.fvcBadge.textContent = `MATCHED (${result.percentage}%)`;
            }
            if (dom.fvcConfidenceTag) {
                dom.fvcConfidenceTag.className = "fvc-confidence-tag match";
                dom.fvcConfidenceTag.textContent = result.confidence;
            }
            if (dom.fvcMeterBar) {
                dom.fvcMeterBar.className = "fvc-meter-bar match";
                dom.fvcMeterBar.style.width = `${result.percentage}%`;
            }
            if (dom.fvcScoreText) {
                dom.fvcScoreText.textContent = `Match Score: ${result.percentage}% (Cosine: ${result.score})`;
            }
            if (dom.fvcVerdict) {
                dom.fvcVerdict.className = "fvc-verdict match";
                dom.fvcVerdict.textContent = `✅ Genuine Match: Live selfie matches the Aadhaar cardholder photo with ${result.confidence.toLowerCase()} confidence.`;
            }
        } else {
            if (dom.fvcBadge) {
                dom.fvcBadge.className = "fvc-badge fvc-mismatch";
                dom.fvcBadge.textContent = `MISMATCH (${result.percentage}%)`;
            }
            if (dom.fvcConfidenceTag) {
                dom.fvcConfidenceTag.className = "fvc-confidence-tag mismatch";
                dom.fvcConfidenceTag.textContent = result.confidence;
            }
            if (dom.fvcMeterBar) {
                dom.fvcMeterBar.className = "fvc-meter-bar mismatch";
                dom.fvcMeterBar.style.width = `${Math.max(8, result.percentage)}%`;
            }
            if (dom.fvcScoreText) {
                dom.fvcScoreText.textContent = `Match Score: ${result.percentage}% (Cosine: ${result.score})`;
            }
            if (dom.fvcVerdict) {
                dom.fvcVerdict.className = "fvc-verdict mismatch";
                dom.fvcVerdict.textContent = `⚠️ Warning: ${result.message}`;
            }
        }
    } catch (err) {
        if (dom.fvcBadge) {
            dom.fvcBadge.className = "fvc-badge fvc-mismatch";
            dom.fvcBadge.textContent = "SERVER OFFLINE";
        }
        if (dom.fvcConfidenceTag) {
            dom.fvcConfidenceTag.className = "fvc-confidence-tag mismatch";
            dom.fvcConfidenceTag.textContent = "ERROR";
        }
        if (dom.fvcMeterBar) {
            dom.fvcMeterBar.className = "fvc-meter-bar mismatch";
            dom.fvcMeterBar.style.width = "0%";
        }
        if (dom.fvcScoreText) {
            dom.fvcScoreText.textContent = "InsightFace Server Connection Error";
        }
        if (dom.fvcVerdict) {
            dom.fvcVerdict.className = "fvc-verdict mismatch";
            dom.fvcVerdict.textContent = `Could not reach InsightFace API server at http://localhost:8000. Ensure the Python backend is running: python server.py (${err.message})`;
        }
    }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

/**
 * Attaches all DOM event listeners.
 *
 * - **Start Camera** — requests camera access and hides the placeholder.
 * - **Flip Camera**  — switches between front / rear camera.
 * - **Upload**       — opens the file picker and processes the selected image.
 * - **Flip Card**    — toggles the result card orientation.
 * - **Scan Again**   — resets the app to the scanner screen.
 * - **Photo error**  — restores the default placeholder if the photo fails to load.
 *
 * @returns {void}
 */
function initEvents() {
    if (dom.btnStart) {
        dom.btnStart.addEventListener("click", async () => {
            dom.btnStart.disabled = true;
            const started = await camera.startCamera();
            if (started && dom.placeholder) dom.placeholder.style.display = "none";
            if (dom.btnSwitch) dom.btnSwitch.disabled = !started;
            if (!started) dom.btnStart.disabled = false;
        });
    }

    if (dom.btnSwitch) {
        dom.btnSwitch.addEventListener("click", () => {
            camera.switchCamera();
        });
    }

    if (dom.btnUpload && dom.fileInput) {
        dom.btnUpload.addEventListener("click", () => dom.fileInput.click());
        dom.fileInput.addEventListener("change", event => {
            handleFileUpload(event, {
                canvas: dom.canvas,
                onQrDetected: handleDetectedPayload,
                onStatus: setStatus,
                onPlaceholderHide: () => {
                    if (dom.placeholder) dom.placeholder.style.display = "none";
                },
            });
        });
    }

    if (dom.flipButton)    dom.flipButton.addEventListener("click", flipCard);
    if (dom.backToScanner) dom.backToScanner.addEventListener("click", scanAgain);

    if (dom.photo) {
        dom.photo.addEventListener("error", () => {
            dom.photo.src = defaultPhotoSrc;
        });
    }

    // Face verification event listeners
    if (dom.btnOpenSelfieCam) dom.btnOpenSelfieCam.addEventListener("click", openSelfieCamera);
    if (dom.btnCancelSelfie)  dom.btnCancelSelfie.addEventListener("click", cancelSelfieCamera);
    if (dom.btnSnapSelfie)    dom.btnSnapSelfie.addEventListener("click", snapSelfie);

    if (dom.btnUploadSelfie && dom.selfieFileInput) {
        dom.btnUploadSelfie.addEventListener("click", () => dom.selfieFileInput.click());
        dom.selfieFileInput.addEventListener("change", (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result === "string") {
                    verifySelfie(reader.result);
                }
            };
            reader.readAsDataURL(file);
        });
    }

    if (dom.btnConfigServer && dom.fvcServerConfig) {
        dom.btnConfigServer.addEventListener("click", () => {
            dom.fvcServerConfig.classList.toggle("is-hidden");
            if (!dom.fvcServerConfig.classList.contains("is-hidden") && dom.fvcServerInput) {
                dom.fvcServerInput.value = getServerUrl();
                dom.fvcServerInput.focus();
            }
        });
    }

    if (dom.btnSaveServer && dom.fvcServerInput) {
        dom.btnSaveServer.addEventListener("click", () => {
            const val = dom.fvcServerInput.value.trim();
            if (val) {
                setServerUrl(val);
                if (dom.fvcServerConfig) dom.fvcServerConfig.classList.add("is-hidden");
                updateServerHealthIndicator();
            }
        });
    }

    if (dom.btnResetServer) {
        dom.btnResetServer.addEventListener("click", () => {
            setServerUrl("");
            if (dom.fvcServerConfig) dom.fvcServerConfig.classList.add("is-hidden");
            updateServerHealthIndicator();
        });
    }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Bootstraps the application.
 *
 * 1. Wires all event listeners via {@link initEvents}.
 * 2. Checks for a `?data=` query parameter in the current URL.
 *    - **Present** → hides the scanner and calls {@link handleDetectedPayload}
 *      to decode and render the result immediately (deep-link / back-button flow).
 *    - **Absent** → shows the scanner in its idle state.
 *
 * @returns {void}
 */
function init() {
    initEvents();

    const params = new URLSearchParams(window.location.search);
    const data = params.get("data");

    if (data) {
        if (dom.scannerSection) dom.scannerSection.style.display = "none";
        handleDetectedPayload(data);
    } else {
        showScanner();
        setStatus("Tap Start Camera to begin scanning");
    }
}

init();
