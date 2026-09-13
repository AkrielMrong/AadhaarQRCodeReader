"""
InsightFace 1:1 Face Verification Backend Server for Aadhaar QR Code Reader
-----------------------------------------------------------------------------
Matches the resident photo embedded in the Aadhaar QR code against a live selfie
using deep learning facial embeddings (ArcFace / MobileFaceNet via InsightFace).
"""

import base64
import io
import os
import sys
import logging
import numpy as np
from PIL import Image
import cv2
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import insightface
from insightface.app import FaceAnalysis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("face_verifier")

app = FastAPI(
    title="Aadhaar Face Verification API",
    description="Offline-capable 1:1 Face Verification using InsightFace ArcFace",
    version="1.0.0"
)

# Enable CORS for browser requests (local or deployed GitHub Pages)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global face analysis instance
face_app = None


def get_face_app():
    global face_app
    if face_app is None:
        logger.info("Initializing InsightFace FaceAnalysis (buffalo_s)...")
        # buffalo_s is lightweight, fast, and optimized for CPU inference
        face_app = FaceAnalysis(
            name="buffalo_s",
            providers=["CPUExecutionProvider"],
            allowed_modules=["detection", "recognition"]
        )
        face_app.prepare(ctx_id=0, det_size=(320, 320))
        logger.info("InsightFace FaceAnalysis ready.")
    return face_app


class VerifyRequest(BaseModel):
    aadhaar_image: str = Field(..., description="Base64 data-uri or raw base64 string of Aadhaar QR photo")
    live_image: str = Field(..., description="Base64 data-uri or raw base64 string of live selfie")
    threshold: float = Field(0.40, description="Cosine similarity threshold (default 0.40)")


def decode_base64_image(b64_string: str) -> np.ndarray:
    """Decodes a base64 or data-URI string into an OpenCV BGR numpy array."""
    try:
        if "," in b64_string:
            b64_string = b64_string.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_string)
        pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        bgr_img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        return bgr_img
    except Exception as e:
        raise ValueError(f"Failed to decode base64 image: {str(e)}")


def extract_face_embedding(app_instance, img_bgr: np.ndarray, is_aadhaar_crop: bool = False):
    """
    Extracts normalized 512-d ArcFace embedding from an image.
    Handles low-resolution tight crops (typical in Aadhaar QRs) with an adaptive pipeline.
    """
    h, w = img_bgr.shape[:2]

    # If image is very small (like 60x60 Aadhaar crop), upscale for SCRFD detector
    if min(h, w) < 160:
        scale = max(160 / h, 160 / w)
        img_bgr = cv2.resize(img_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

    faces = app_instance.get(img_bgr)

    if len(faces) > 0:
        # Pick the largest face detected
        faces = sorted(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
        return faces[0].normed_embedding, True, [float(x) for x in faces[0].bbox]

    # Fallback for tightly cropped Aadhaar ID photos where face detector cannot find forehead/shoulders
    if is_aadhaar_crop:
        try:
            logger.info("Applying direct alignment fallback for tightly cropped ID photo...")
            rec_model = app_instance.models.get("recognition")
            if rec_model is not None:
                # Resize to standard ArcFace input size (112x112)
                aligned = cv2.resize(img_bgr, (112, 112), interpolation=cv2.INTER_CUBIC)
                feat = rec_model.get_feat(aligned).flatten()
                norm = np.linalg.norm(feat)
                if norm > 0:
                    feat = feat / norm
                return feat, True, [0.0, 0.0, float(w), float(h)]
        except Exception as err:
            logger.warning(f"ID crop fallback failed: {err}")

    return None, False, None


def compute_cosine_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
    """Computes cosine similarity between two normalized vectors."""
    dot = np.dot(emb1, emb2)
    norm1 = np.linalg.norm(emb1)
    norm2 = np.linalg.norm(emb2)
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return float(dot / (norm1 * norm2))


@app.get("/")
@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "Aadhaar InsightFace Verifier",
        "engine": "ArcFace / MobileFaceNet (buffalo_s)",
        "offline": True
    }


@app.post("/api/verify")
def verify_face(req: VerifyRequest):
    """
    Compares the Aadhaar QR photo against a live selfie.
    Returns cosine similarity, match boolean, confidence, and detection metadata.
    """
    try:
        aadhaar_bgr = decode_base64_image(req.aadhaar_image)
        live_bgr = decode_base64_image(req.live_image)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ai_app = get_face_app()

    aadhaar_emb, aadhaar_detected, aadhaar_bbox = extract_face_embedding(
        ai_app, aadhaar_bgr, is_aadhaar_crop=True
    )
    live_emb, live_detected, live_bbox = extract_face_embedding(
        ai_app, live_bgr, is_aadhaar_crop=False
    )

    if not aadhaar_detected:
        return {
            "match": False,
            "score": 0.0,
            "percentage": 0.0,
            "threshold": req.threshold,
            "confidence": "NONE",
            "aadhaar_face_detected": False,
            "live_face_detected": live_detected,
            "message": "No face could be found in the Aadhaar card photo"
        }

    if not live_detected:
        return {
            "match": False,
            "score": 0.0,
            "percentage": 0.0,
            "threshold": req.threshold,
            "confidence": "NONE",
            "aadhaar_face_detected": True,
            "live_face_detected": False,
            "message": "No face detected in live selfie. Please align your face in good lighting."
        }

    similarity = compute_cosine_similarity(aadhaar_emb, live_emb)
    # Cosine similarity in ArcFace typically ranges from -0.2 to +0.85
    # Normalizing into a readable 0% - 100% confidence scale
    match = bool(similarity >= req.threshold)
    percentage = max(0.0, min(100.0, round(((similarity + 0.1) / 0.9) * 100, 1)))

    if similarity >= 0.55:
        confidence = "VERY HIGH"
    elif similarity >= 0.45:
        confidence = "HIGH"
    elif similarity >= 0.38:
        confidence = "MODERATE"
    else:
        confidence = "LOW / MISMATCH"

    return {
        "match": match,
        "score": round(similarity, 4),
        "percentage": percentage,
        "threshold": req.threshold,
        "confidence": confidence,
        "aadhaar_face_detected": True,
        "live_face_detected": True,
        "details": {
            "aadhaar_bbox": aadhaar_bbox,
            "live_bbox": live_bbox
        },
        "message": "Face matched successfully" if match else "Face mismatch: selfie does not match Aadhaar cardholder"
    }


if __name__ == "__main__":
    import uvicorn
    # Warm up model on startup
    get_face_app()
    uvicorn.run(app, host="0.0.0.0", port=8000)
