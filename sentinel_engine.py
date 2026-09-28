import os
import cv2
import csv
import json
import base64
import time
import hashlib
import logging
import requests
import threading
from datetime import datetime, timezone
from ultralytics import YOLO
from flask import Flask, Response
from flask_cors import CORS

# --- GOOGLE AUTHENTICATION ---
from google.oauth2 import service_account
import google.auth.transport.requests

# ==============================================================================
# CONFIGURATION & CONSTANTS
# ==============================================================================
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s: %(message)s')

FIREBASE_DB_URL = "https://cctv-b93f0-default-rtdb.firebaseio.com"
CAMERA_ID = "cam21"
VIDEO_FILENAME = "cam21.mp4"
REPORT_CSV_PATH = "sentinel_transit_report.csv"
TARGET_CLASSES = [2, 3, 5, 7]  # Car, Motorcycle, Bus, Truck

GCP_PROJECT_ID = "swing-trade-bot-504408"
GCP_REGION = "us-central1"
SERVICE_ACCOUNT_JSON = "gcp-key.json"

API_COOLDOWN_SECONDS = 2.5
last_api_call_time = 0

# ==============================================================================
# SMART PATH RESOLVER
# ==============================================================================
def resolve_video_source(filename):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(script_dir)
    search_paths = [
        os.path.join(parent_dir, "public", filename),
        os.path.join(script_dir, "..", "public", filename),
        os.path.join(script_dir, filename),
        os.path.join(parent_dir, filename),
        os.path.join("public", filename),
        filename
    ]
    for path in search_paths:
        normalized = os.path.normpath(path)
        if os.path.exists(normalized):
            logging.info(f"📹 Loaded Video Asset: {normalized}")
            return normalized
    logging.warning(f"⚠️ Video {filename} not located. Defaulting to relative string.")
    return filename

VIDEO_SOURCE = resolve_video_source(VIDEO_FILENAME)

# ==============================================================================
# FLASK REAL-TIME STREAMING SERVER (Port 5001)
# ==============================================================================
app = Flask(__name__)
CORS(app)

current_annotated_frame = None
frame_lock = threading.Lock()

def generate_web_feed():
    global current_annotated_frame
    while True:
        with frame_lock:
            if current_annotated_frame is None:
                time.sleep(0.01)
                continue
            ret, buffer = cv2.imencode('.jpg', current_annotated_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if not ret:
                continue
            frame_bytes = buffer.tobytes()

        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        time.sleep(0.033)  # ~30 FPS

@app.route('/anpr_feed')
def anpr_feed():
    return Response(generate_web_feed(), mimetype='multipart/x-mixed-replace; boundary=frame')

def start_flask():
    app.run(host='0.0.0.0', port=5001, threaded=True, debug=False, use_reloader=False)

threading.Thread(target=start_flask, daemon=True).start()
logging.info("🚀 AI MJPEG Stream active on http://localhost:5001/anpr_feed")

# ==============================================================================
# INITIALIZE CSV FORENSIC EXPORT
# ==============================================================================
if not os.path.exists(REPORT_CSV_PATH):
    with open(REPORT_CSV_PATH, mode='w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(["Timestamp_UTC", "Camera_ID", "Plate_Number", "Make_Model", "Vehicle_Type", "Color", "Confidence", "Clarity_Score", "Method"])

def log_to_csv(timestamp, cam_id, plate, make_model, v_type, color, conf, clarity, method):
    try:
        with open(REPORT_CSV_PATH, mode='a', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([timestamp, cam_id, plate, make_model, v_type, color, f"{conf:.2f}", clarity, method])
    except Exception as e:
        logging.error(f"CSV Logging Failed: {e}")

# ==============================================================================
# SERVICE ACCOUNT AUTHENTICATION
# ==============================================================================
try:
    logging.info("🔐 Loading Enterprise Service Account Credentials...")
    gcp_creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_JSON,
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    auth_req = google.auth.transport.requests.Request()
except Exception as e:
    logging.error(f"❌ Failed to load {SERVICE_ACCOUNT_JSON}: {e}")

# ==============================================================================
# DETERMINISTIC PARIVAHAN / RTO RESOLVER
# ==============================================================================
def generate_mock_rto_dossier(plate_number):
    if plate_number == "UNREADABLE":
        return None

    hash_val = int(hashlib.md5(plate_number.encode()).hexdigest(), 16)
    insurance_valid = (hash_val % 100) > 30
    has_challans = (hash_val % 100) < 40

    dossier = {
        "registration_status": "ACTIVE",
        "insurance_status": "VALID" if insurance_valid else "EXPIRED",
        "pucc_status": "VALID" if (hash_val % 10) > 2 else "EXPIRED",
        "pending_challans": [],
        "total_fine_amount": 0
    }

    if not insurance_valid:
        dossier["total_fine_amount"] += 2000

    if has_challans:
        num_challans = (hash_val % 2) + 1
        challan_types = [
            {"reason": "Signal Violation", "amount": 1000},
            {"reason": "Over-speeding (Corridor Limit Exceeded)", "amount": 2000},
            {"reason": "Without Seatbelt/Helmet", "amount": 500}
        ]
        for i in range(num_challans):
            item = challan_types[(hash_val + i) % len(challan_types)]
            dossier["pending_challans"].append(item)
            dossier["total_fine_amount"] += item["amount"]

    return dossier

# ==============================================================================
# VERTEX AI / GEMINI MULTIMODAL INFERENCE
# ==============================================================================
def analyze_vehicle_with_gemini(bgr_image, track_id, clarity_score):
    try:
        gcp_creds.refresh(auth_req)
        access_token = gcp_creds.token

        _, buffer = cv2.imencode('.jpg', bgr_image, [cv2.IMWRITE_JPEG_QUALITY, 92])
        image_base64 = base64.b64encode(buffer).decode('utf-8')
        image_data_uri = f"data:image/jpeg;base64,{image_base64}"

        models_to_try = [
            "gemini-2.5-flash-lite",
            "gemini-2.5-flash",
            "gemini-2.5-pro"
        ]

        prompt_text = (
            "Analyze this vehicle snapshot from an Indian surveillance camera.\n"
            "INDIAN RTO SYNTAX RULES:\n"
            "1. Standard: [State: 2 letters][RTO: 2 digits][Series: 1-3 letters][Number: strictly 4 numeric digits] "
            "(e.g., 'GJ14AK5980', 'DL01AB1234'). The last 4 characters are ALWAYS NUMERIC DIGITS (0-9). "
            "If a blurred digit looks like 'E', 'B', or 'O', it is '8', '6', or '0'.\n"
            "2. Bharat (BH) Series: [Year: 2 digits]BH[Number: 4 digits][Suffix: 1-2 letters] (e.g., '22BH1234AA').\n\n"
            "CONFIDENCE SCORING:\n"
            "- Sharp and unambiguous characters: 0.90 to 0.99.\n"
            "- Blur, smeared, or low-resolution: 0.35 to 0.65.\n"
            "- Illegible: 'UNREADABLE' with confidence 0.00.\n\n"
            "Return a strictly valid JSON object with keys:\n"
            "1. 'plate_number': Alphanumeric string with no spaces.\n"
            "2. 'confidence_score': Float between 0.00 and 1.00.\n"
            "3. 'make': Vehicle manufacturer (e.g., 'Hyundai', 'Maruti Suzuki', 'Tata', 'Honda', 'Toyota', 'Unknown').\n"
            "4. 'model': Vehicle model name (e.g., 'Creta', 'Swift', 'City', 'Nexon', 'Unknown').\n"
            "5. 'vehicle_type': Category ('Car', 'SUV', 'Sedan', 'Hatchback', 'Motorcycle', 'Scooter', 'Truck', 'Bus').\n"
            "6. 'color': Dominant exterior vehicle color."
        )

        payload = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": prompt_text},
                    {"inlineData": {"mimeType": "image/jpeg", "data": image_base64}}
                ]
            }],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json"
            }
        }

        headers = {
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/json'
        }

        for model_name in models_to_try:
            url = f"https://{GCP_REGION}-aiplatform.googleapis.com/v1/projects/{GCP_PROJECT_ID}/locations/{GCP_REGION}/publishers/google/models/{model_name}:generateContent"
            try:
                response = requests.post(url, headers=headers, json=payload, timeout=12)
                if response.status_code == 200:
                    result_json_str = response.json()['candidates'][0]['content']['parts'][0]['text']
                    cloud_data = json.loads(result_json_str)
                    push_to_firebase(cloud_data, track_id, image_data_uri, clarity_score)
                    return
                elif response.status_code in [429, 503]:
                    logging.warning(f"⚠️ Rate limit on {model_name}. Retrying fallback...")
                    continue
                else:
                    logging.error(f"⚠️ Vertex Error ({model_name}): {response.text}")
                    break
            except Exception as e:
                logging.error(f"❌ Connection error for {model_name}: {e}")
                break

    except Exception as general_err:
        logging.error(f"❌ Gemini pipeline failure: {general_err}")

# ==============================================================
# FIREBASE METADATA SYNC & WATCHLIST INTERCEPTION
# ==============================================================
def push_to_firebase(cloud_data, track_id, image_data_uri, clarity_score):
    if not cloud_data:
        return

    plate = cloud_data.get('plate_number', 'UNREADABLE').strip().upper()
    make = cloud_data.get('make', 'Unknown')
    model = cloud_data.get('model', 'Unknown')
    v_type = cloud_data.get('vehicle_type', 'Vehicle')
    color = cloud_data.get('color', 'Unknown')
    ai_confidence = float(cloud_data.get('confidence_score', 0.0))

    if make != 'Unknown' or model != 'Unknown':
        entity_name = f"{make} {model}".replace("Unknown", "").strip()
    else:
        entity_name = v_type

    method = "ANPR_Read" if plate != "UNREADABLE" else "ReID_Match"
    timestamp_iso = datetime.now(timezone.utc).isoformat()
    rto_dossier = generate_mock_rto_dossier(plate)

    payload = {
        "camera_id": CAMERA_ID,
        "plate_number": plate,
        "entity_type": entity_name,
        "vehicle_type": v_type,
        "make": make,
        "model": model,
        "color": color,
        "method": method,
        "confidence": ai_confidence,
        "clarity_score": clarity_score,
        "image_data": image_data_uri,
        "rto_dossier": rto_dossier,
        "timestamp_utc": timestamp_iso
    }

    try:
        # Write to transits
        requests.post(f"{FIREBASE_DB_URL}/transits.json", json=payload, timeout=4)
        
        # Write to output CSV report for official deliverables
        log_to_csv(timestamp_iso, CAMERA_ID, plate, entity_name, v_type, color, ai_confidence, clarity_score, method)

        conf_pct = int(ai_confidence * 100)
        logging.info(f"✅ UPLINK [{method}] (ID:{track_id}): {color} {entity_name} -> Plate: {plate} (Clarity: {clarity_score}%, Conf: {conf_pct}%)")

        if plate != "UNREADABLE":
            check_and_trigger_watchlist(plate, entity_name, color, image_data_uri, rto_dossier, timestamp_iso)

    except Exception as e:
        logging.error(f"❌ Firebase ingestion failed: {e}")

def check_and_trigger_watchlist(detected_plate, entity_name, color, image_data_uri, rto_dossier, timestamp_iso):
    try:
        wl_resp = requests.get(f"{FIREBASE_DB_URL}/watchlist.json", timeout=2)
        if wl_resp.status_code == 200 and wl_resp.json():
            watchlist_entries = wl_resp.json()
            clean_detected = detected_plate.replace('-', '').replace(' ', '')

            for key, target in watchlist_entries.items():
                target_plate = target.get('plate', '').upper().replace('-', '').replace(' ', '')
                if target_plate and (target_plate == clean_detected or target_plate in clean_detected):
                    alert_payload = {
                        "camera_id": CAMERA_ID,
                        "plate_number": detected_plate,
                        "entity_type": f"{color} {entity_name}".strip(),
                        "reason": target.get('reason', 'Stolen Vehicle / eGujCop Match'),
                        "timestamp_utc": timestamp_iso,
                        "image_data": image_data_uri,
                        "rto_dossier": rto_dossier
                    }
                    requests.post(f"{FIREBASE_DB_URL}/alerts.json", json=alert_payload, timeout=3)
                    logging.warning(f"🚨🚨 [WATCHLIST INTERCEPT] Target Plate {detected_plate} caught on {CAMERA_ID.upper()}! 🚨🚨")
                    break
    except Exception as err:
        logging.debug(f"Watchlist lookup notice: {err}")

# ==============================================================
# EDGE TRACKER ENGINE
# ==============================================================
class SentinelEngine:
    def __init__(self):
        logging.info("Initializing Edge YOLOv8 Tracker...")
        self.yolo_model = YOLO("yolov8n.pt")
        self.processed_track_ids = set()

    def calculate_clarity(self, image):
        try:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            variance = cv2.Laplacian(gray, cv2.CV_64F).var()
            return int(min(98, max(38, (variance / 4.5) + 32)))
        except Exception:
            return 85

    def run(self):
        global last_api_call_time, current_annotated_frame

        cap = cv2.VideoCapture(VIDEO_SOURCE)
        if not cap.isOpened():
            logging.error(f"❌ Cannot open video feed: {VIDEO_SOURCE}")
            return

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        frame_duration = 1.0 / fps

        cv2.namedWindow("Sentinel Edge Tracker (Local)", cv2.WINDOW_NORMAL)
        cv2.resizeWindow("Sentinel Edge Tracker (Local)", 1280, 720)

        while True:
            start_time = time.time()
            ret, frame = cap.read()
            if not ret:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue

            h, w = frame.shape[:2]
            trigger_y = int(h * 0.75)
            
            # HUD elements
            cv2.line(frame, (0, trigger_y), (w, trigger_y), (0, 165, 255), 2)
            cv2.putText(frame, "ANPR RECOGNITION CORRIDOR (75%)", (15, trigger_y - 12),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)

            results = self.yolo_model.track(frame, persist=True, classes=TARGET_CLASSES, imgsz=640, verbose=False)[0]

            if results.boxes is not None and results.boxes.id is not None:
                boxes = results.boxes.xyxy.cpu().numpy().astype(int)
                track_ids = results.boxes.id.cpu().numpy().astype(int)

                for box, track_id in zip(boxes, track_ids):
                    x1, y1, x2, y2 = box
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 120), 2)
                    cv2.putText(frame, f"TRACK ID:{track_id}", (x1, max(20, y1 - 8)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 120), 2)

                    if y2 > trigger_y and track_id not in self.processed_track_ids:
                        current_time = time.time()
                        if current_time - last_api_call_time >= API_COOLDOWN_SECONDS:
                            self.processed_track_ids.add(track_id)
                            last_api_call_time = current_time

                            vehicle_crop = frame[max(0, y1):min(h, y2), max(0, x1):min(w, x2)].copy()

                            if vehicle_crop.size > 0:
                                clarity = self.calculate_clarity(vehicle_crop)
                                logging.info(f"🎯 Target ID {track_id} crossed trigger corridor. Dispatching to Vertex AI...")
                                threading.Thread(
                                    target=analyze_vehicle_with_gemini,
                                    args=(vehicle_crop, track_id, clarity),
                                    daemon=True
                                ).start()
                        else:
                            self.processed_track_ids.add(track_id)

            with frame_lock:
                current_annotated_frame = frame.copy()

            elapsed = time.time() - start_time
            sleep_time = frame_duration - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

            cv2.imshow("Sentinel Edge Tracker (Local)", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        cap.release()
        cv2.destroyAllWindows()

if __name__ == "__main__":
    engine = SentinelEngine()
    engine.run()
