# 🧑‍💼 InsightFace 1:1 Face Verification Backend

High-precision 1:1 facial biometric verification between an **Aadhaar Secure QR photo** and a **live camera selfie** using [InsightFace](https://github.com/deepinsight/insightface) (SCRFD face detection + ArcFace MobileFaceNet embedding extraction).

---

## ⚡ Quick Start

### 1. Install Dependencies
```bash
# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install requirements
pip install -r requirements.txt
```

### 2. Run the Verification API Server
```bash
python server.py
```
Server runs on `http://localhost:8000` with CORS enabled so the web app can connect seamlessly.

---

## 📡 API Reference

### Health Check
- **Endpoint**: `GET /health`
- **Response**:
  ```json
  {
    "status": "healthy",
    "service": "Aadhaar InsightFace Verifier",
    "engine": "ArcFace / MobileFaceNet (buffalo_s)",
    "offline": true
  }
  ```

### Verify Face
- **Endpoint**: `POST /api/verify`
- **Request Body**:
  ```json
  {
    "aadhaar_image": "data:image/jpeg;base64,...",
    "live_image": "data:image/jpeg;base64,...",
    "threshold": 0.40
  }
  ```
- **Response**:
  ```json
  {
    "match": true,
    "score": 0.7842,
    "percentage": 78.4,
    "threshold": 0.40,
    "confidence": "HIGH",
    "aadhaar_face_detected": true,
    "live_face_detected": true,
    "message": "Face matched successfully"
  }
  ```

---

## 🛠️ CLI Standalone Tool
You can also run verification directly from the command line without the web UI:

```bash
python verify_cli.py path/to/aadhaar_photo.png path/to/selfie.jpg
```
Output:
```
==================================================
Cosine Similarity Score : 0.8124
Threshold               : 0.40
Face Match Status       : MATCHED (GENUINE)
==================================================
```
