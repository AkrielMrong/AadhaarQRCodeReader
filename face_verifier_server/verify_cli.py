#!/usr/bin/env python3
"""
CLI tool for 1:1 Face Verification between Aadhaar photo and live selfie
Usage:
    python verify_cli.py <aadhaar_photo_path> <selfie_photo_path> [--threshold 0.40]
"""

import sys
import argparse
import cv2
import numpy as np
from insightface.app import FaceAnalysis

def main():
    parser = argparse.ArgumentParser(description="InsightFace 1:1 Face Verification")
    parser.add_argument("aadhaar_photo", help="Path to Aadhaar card resident photo")
    parser.add_argument("selfie_photo", help="Path to live selfie photo")
    parser.add_argument("--threshold", type=float, default=0.40, help="Cosine similarity match threshold (default 0.40)")
    args = parser.parse_args()

    print(f"[*] Loading InsightFace buffalo_s...")
    app = FaceAnalysis(name="buffalo_s", providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"])
    app.prepare(ctx_id=0, det_size=(320, 320))

    img1 = cv2.imread(args.aadhaar_photo)
    if img1 is None:
        print(f"[!] Error: Could not read image at {args.aadhaar_photo}")
        sys.exit(1)

    img2 = cv2.imread(args.selfie_photo)
    if img2 is None:
        print(f"[!] Error: Could not read image at {args.selfie_photo}")
        sys.exit(1)

    # Upscale if low-res
    h1, w1 = img1.shape[:2]
    if min(h1, w1) < 160:
        scale = max(160 / h1, 160 / w1)
        img1 = cv2.resize(img1, (int(w1 * scale), int(h1 * scale)), interpolation=cv2.INTER_CUBIC)

    faces1 = app.get(img1)
    if len(faces1) == 0:
        # Fallback direct recognition for ID crop
        print("[!] Detection failed on ID photo, falling back to direct alignment crop...")
        rec = app.models.get("recognition")
        aligned = cv2.resize(img1, (112, 112))
        emb1 = rec.get_feat(aligned).flatten()
        emb1 = emb1 / np.linalg.norm(emb1)
    else:
        emb1 = faces1[0].normed_embedding

    faces2 = app.get(img2)
    if len(faces2) == 0:
        print("[!] No face found in selfie photo!")
        sys.exit(1)
    emb2 = faces2[0].normed_embedding

    sim = float(np.dot(emb1, emb2) / (np.linalg.norm(emb1) * np.linalg.norm(emb2)))
    match = sim >= args.threshold

    print("=" * 50)
    print(f"Cosine Similarity Score : {sim:.4f}")
    print(f"Threshold               : {args.threshold:.2f}")
    print(f"Face Match Status       : {'MATCHED (GENUINE)' if match else 'MISMATCH (ALERT / FRAUD)'}")
    print("=" * 50)

if __name__ == "__main__":
    main()
