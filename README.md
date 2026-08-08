# SeeSense — Navigation Assistance for Visually Impaired Users

SeeSense is a mobile-first web application that transforms a smartphone into a real-time navigation aid for blind and visually-impaired pedestrians. Using the phone's rear camera and a custom-trained object detection model, the app identifies obstacles in the user's path and provides alerts through **Hebrew speech synthesis** and **haptic feedback**.

**🎯 Primary User:** Blind and visually-impaired pedestrians  
**📱 Platform:** Mobile web app (HTML5 + WebSocket streaming)  
**🌐 Language:** Hebrew (RTL interface)  
**🚀 Deployment:** GCP Compute Engine VM (GPU-backed)


---

## Key Features

### Real-Time Detection & Alerts
- **Live camera streaming** — captures frames from the phone's rear camera
- **Object detection** — runs a fine-tuned YOLOv8 model on each frame (~14 urban obstacle classes)
- **Smart motion tracking** — persists object identity across frames; computes approach speed and direction
- **Motion-first alerting** — only *approaching* objects trigger red alerts; static obstacles go silent
- **Multilingual output** — Hebrew TTS voice alerts + haptic vibration patterns
- **Sub-100ms latency** — optimized WebSocket streaming + GPU inference

### Safety & Accessibility
- **Gyroscope-based alignment** — requires phone to be held upright before sending frames
- **Connection health watchdog** — monitors network latency; warns when connection degrades
- **SOS emergency alerts** — one-tap button sends GPS coordinates to verified emergency contacts via email
- **Dual feedback channels** — users choose audio-only, haptic-only, or both

### Session Management & Feedback
- **Persistent session history** — grouped by scan session; supports period filters
- **Two-axis feedback system** — users report misdetections; admins triage and respond
- **Per-session statistics** — frame counts, alert summary, "safety score" (inverse of danger-frame ratio)

### Admin Dashboard (Multi-Level)
- **Level 1 Admin** — view all system data; manage regular users; triage feedback
- **Level 2 (Super) Admin** — everything: delete users, grant/revoke roles, reset performance data
- **Performance metrics** — live or time-range views of latency, throughput, FPS, per-stage breakdowns
- **System-wide streaming config** — adjust input size, compression, and pipeline depth globally
- **User management** — presence, data counts, password reset, account deletion
- **Feedback management** — triage, assign, and respond to user reports

---

## Architecture

### Frontend (React + Vite)
**`Client/`** — A mobile-first SPA with no external dependencies for the camera/speech APIs.

**Key modules:**
- `CameraView.jsx` — captures frames via HTML5 canvas; implements pinch-to-zoom
- `VisionStream` (visionService.js) — manages the WebSocket; handles adaptive send-rate backpressure
- `feedbackService.js` — Hebrew TTS, haptic patterns, and settings store
- `healthService.js` — connection watchdog with 4-tier status (green/yellow/orange/red)

**Tech:** React 19, Vite, framer-motion, axios, WebSocket (native), Web Speech API, Vibration API

### Backend (FastAPI)
**`Server/`** — A real-time streaming server with database persistence and admin APIs.

**Key modules:**
- `stream.py` — WebSocket `/stream/ws` endpoint; frame processing pipeline
- `ml_engine/model_loader.py` — YOLO inference (PyTorch on GPU or CPU)
- `motion_tracker.py` — ByteTrack-inspired multi-object tracker
- `logic_service.py` — danger assessment (motion-first alert classification)
- `services/` — user auth, settings, feedback triage, email notifications, performance metrics
- `admin.py` — three-level permission model (regular / admin / super-admin)

**Tech:** FastAPI, Uvicorn, PyTorch, Ultralytics YOLO, MongoDB, PyJWT, bcrypt

### Database
**MongoDB Atlas** — collections for users, sessions, detection history, feedback, emergency contacts, performance metrics

---

## Frame Processing Pipeline

Each captured frame follows this path:

```
Client                          Server
┌──────────────────────────┐
│ Capture 640×640 JPEG     │
│ (if aligned & has quota) │
└──────────────┬───────────┘
               │
               ├─ JPEG binary over WebSocket →
                                        ┌─────────────────┐
                                        │ 1. Decode & QA  │
                                        │ 2. Inference    │
                                        │ 3. Track motion │
                                        │ 4. Assess danger│
                                        │ 5. Async DB     │
                                        └────────┬────────┘
                                                 │
               ← JSON result ──────────────────────┘
               
┌──────────────────────┐
│ TTS + haptics        │
│ (if alert is new)    │
│ Update HUD overlay   │
└──────────────────────┘
```

**Optimizations:**
- Input size, compression, and pipeline depth are globally configurable (admin page)
- Inference runs in a worker thread; event loop stays responsive for health pings
- Settings cached in memory; zero DB reads per frame
- Alert dedup per track ID — same object doesn't re-trigger TTS on every frame
- Backpressure governs send rate: `FPS ≈ max_inflight / RTT` (self-throttles to network capacity)

---

## Tech Stack Summary

| Layer | Choice |
|-------|--------|
| **Frontend Framework** | React 19 + Vite |
| **Real-time Transport** | WebSocket (binary up, JSON down) |
| **Camera/Canvas** | `navigator.mediaDevices.getUserMedia` + HTML5 Canvas |
| **Sensors** | `DeviceOrientationEvent`, `navigator.geolocation` |
| **Speech** | Web Speech API (Hebrew TTS) |
| **Haptics** | Vibration API (`navigator.vibrate`) |
| **Backend Framework** | FastAPI + Uvicorn |
| **ML Runtime** | PyTorch + Ultralytics YOLO |
| **Image Processing** | OpenCV, NumPy |
| **Tracking** | SciPy (Hungarian algorithm) |
| **Database** | MongoDB (PyMongo) |
| **Auth** | PyJWT (HS256) + bcrypt |
| **Hosting** | GCP Compute Engine VM (n1-standard-1 + T4 GPU) |
| **Email** | Gmail SMTP (transactional) |

---

## Getting Started

### Prerequisites
- **Node.js 16+** (for client build)
- **Python 3.11+** (for server)
- **MongoDB Atlas** (or local MongoDB)
- **Email account** with app password (for email notifications)
- **GCP project** (for production deployment)

### Local Development

#### Backend Setup
```bash
cd Server

# Install Python dependencies
pip install -r requirements.txt

# Create .env file with your secrets
# (see Server/DEPLOYMENT.md for required variables)

# Run the server
python main.py
# Starts on http://127.0.0.1:8000
```

#### Frontend Setup
```bash
cd Client

# Install JavaScript dependencies
npm install

# Start dev server
npm run dev
# Opens at http://localhost:5173
# Point it at http://localhost:8000 (default in .env)

# Or build for production
npm run build
```

**⚠️ GPU availability:** Local inference uses GPU if available; Railway and GCP deployments differ. See `Server/DEPLOYMENT.md` for environment-specific configuration.

### Running Both Together
1. Start the server (separate terminal): `cd Server && python main.py`
2. Start the client dev server: `cd Client && npm run dev`
3. Open http://localhost:5173 in your browser
4. Register a test account and connect

---

## Deployment

### Production: GCP Compute Engine

**One-command deploy from your machine:**
```bash
bash deploy/remote-update.sh
```

**Manual operations on the VM (via SSH):**
```bash
# Check status
sudo systemctl status seesense --no-pager -l

# Live logs
sudo journalctl -u seesense -f

# Update & restart
cd ~/SeeSense && bash deploy/update.sh
```

**Setup details** (see `Server/DEPLOYMENT.md`):
- **Region:** `europe-central2-c` (Warsaw) — closest to Israel with available T4 GPU capacity
- **Machine:** `n1-standard-1` (1 vCPU, 3.75GB) + 1× T4 GPU
- **Domain:** `34-116-162-196.nip.io` (auto-resolves external IP; free HTTPS via Let's Encrypt)
- **Cost:** ~$0.40/hr when running; ~$0 when stopped (disk only)

**Build modes:**
- `.env.production` — build for production (empty `VITE_API_URL` = same-origin)
- `.env.gcp` — build for GCP deployment (`npm run build -- --mode gcp`)

### Dockerfile
Single-service architecture: FastAPI server serves the built React app from its own origin.
```dockerfile
# Uses python:3.11-slim + OpenCV deps
# Exposes port 8000 (or $PORT)
# Runs uvicorn main:app with proper keep-alive timeout
```

---

## Configuration

### Server: `core/config.py`
All tunable constants in one place:
- **Model:** `MODEL_PATH` (points to `ml_engine/seesense_model.pt`)
- **Inference:** `CONFIDENCE_THRESHOLD` (0.4), `NMS_IOU_THRESHOLD` (0.45)
- **Input:** frame size (160–640), quality gates (blur, darkness, overexposure)
- **Sensitivity profiles:** low/medium/high detection thresholds
- **Classes:** 14 urban obstacles (person, car, dog, stairs, etc.)

### Client: `config/streamConfig.js`
Formerly client constants; now **admin-editable via the server:**
- **`input_size`** — 160–640 px (smaller = faster, less detail)
- **`compression_percent`** — 0–95% (higher = smaller uploads, lower quality)
- **`max_inflight`** — 1–16 (pipeline depth; see Architecture)

**Admin page:** `/admin/stream-config` (Level 2 write, Level 1 read)

---

## Project Structure

```
SeeSense-main/
├── Client/                        React + Vite frontend
│   ├── src/
│   │   ├── components/            CameraView, HUD layers
│   │   ├── pages/                 Dashboard, Settings, Admin pages
│   │   ├── services/              WebSocket, TTS, health watchdog
│   │   ├── context/               Authentication, session state
│   │   └── config/                Stream configuration
│   ├── .env                       (local dev)
│   ├── .env.production            (npm run build)
│   ├── .env.gcp                   (npm run build -- --mode gcp)
│   ├── vite.config.js
│   └── CLIENT.md                  Frontend documentation
│
├── Server/                        FastAPI backend
│   ├── main.py                    App factory, lifespan, static routing
│   ├── api/                       HTTP + WebSocket routers
│   │   ├── stream.py              Real-time frame processing
│   │   ├── users.py               Auth, profile, history, feedback, SOS
│   │   ├── admin.py               User management, feedback triage
│   │   ├── settings.py            Per-user detection preferences
│   │   └── inference.py           Pause/resume detection
│   ├── services/                  Business logic
│   │   ├── vision_service.py      Image decode & quality gates
│   │   ├── motion_tracker.py      ByteTrack-style tracking
│   │   ├── logic_service.py       Danger assessment
│   │   ├── user_service.py        User CRUD, auth, feedback
│   │   ├── session_service.py     Session lifecycle & cache
│   │   └── email_service.py       12 transactional email templates
│   ├── ml_engine/
│   │   ├── model_loader.py        YOLO load & inference
│   │   └── seesense_model.pt      Fine-tuned weights (6.2 MB)
│   ├── core/
│   │   ├── config.py              All tunable constants
│   │   ├── auth.py                JWT, token blacklist, admin levels
│   │   └── database.py            MongoDB client, indexes
│   ├── Dockerfile                 Container image
│   ├── requirements.txt
    └── SERVER.md                  Backend documentation
│
├── deploy/
│   ├── setup-vm.sh                Full VM setup (run once)
│   ├── update.sh                  Fast pull + conditional rebuild
│   ├── remote-update.sh           Deploy from your machine via SSH
│   └── DEPLOYMENT.md              Detailed deployment guide
│
└── README.md                       This file
```

---

## Documentation

- **`Server/DEPLOYMENT.md`** — How to set up and manage the GCP deployment, costs, troubleshooting
- **`Server/SERVER.md`** — Complete backend reference (API endpoints, pipeline details, schema, known issues)
- **`Client/CLIENT.md`** — Complete frontend reference (routing, components, services, accessibility)

---

## Key Decisions & Tradeoffs

### Why Motion-First Alerting?
The app must **not** exhaust users with false alarms. A static scene — parked cars, furniture, standing people — raises no alert. Only *actively approaching* objects trigger red danger. This keeps the app usable for real-world navigation.

### Why WebSocket Streaming Over REST?
HTTP per-frame would require handshake + headers on every frame. WebSocket streams binary efficiently and lets the server push results in order, enabling latency measurement and backpressure.

### Why Server-Side Inference?
YOLO on a phone browser is not feasible (JS runtime overhead, no hardware acceleration). Server inference means consistent, accurate results and lets us deploy model updates without app updates.

### Why GPU?
CPU-only inference (~200 ms/frame) makes the app unusable outdoors. GPU reduces inference to ~20–30 ms, enabling ~40 FPS sustained throughput. The T4 is minimal overkill; the model uses a tiny fraction of its VRAM.

### Why Mongo Over SQL?
Flexible schema for session history, feedback metadata, and admin audit trails. Built-in TTL indexes for auto-expiring tokens and reset codes. Atlas handles backups and uptime guarantees.

---

## Performance & Optimization

| Optimization | Impact |
|---|---|
| In-memory settings cache | 0 ms vs 71 ms per frame |
| Async DB write (detection insertion) | Moved off hot path |
| Inference in worker thread | Keeps event loop responsive for health pings |
| Global inference lock (serialized YOLO) | Prevents concurrency bugs; matches hardware capacity |
| Configurable input size | Dropping 640→512 = ~35% faster inference |
| Windowed motion tracking | Smooths jitter; enables slow-approach detection |
| Alert dedup per track ID | Eliminates redundant TTS/haptics for static objects |
| Client backpressure | Throughput adapts to RTT; latency stays low |

---

## Testing & Development

### Manual Testing
- **Interactive WebSocket client** — `Server/tests/test_ws.py` sends images/videos and reports detections per frame
- **Local GPU** — faster iteration than remote deployment
- **Phone testing** — requires HTTPS (ngrok tunnel or GCP)

### No Automated Test Suite
The repository has no unit tests. Critical pure functions for testing:
- `logic_service._classify_alert()` — alert classification rules
- `motion_tracker.get_motion()` — approach detection

---

## Known Issues & Future Work

### Solved
- ✅ Static vehicle false alerts (motion-first rewrite)
- ✅ Alert spam (per-track dedup)
- ✅ Client send rate (backpressure + adaptive pipeline)
- ✅ Approach detection (trend-based instead of magnitude)
- ✅ Cellular bandwidth (adaptive JPEG quality)

### Open / Out of Scope
- Cellular link optimization — detected but not yet tuned (64 KB/frame × 40 FPS = 21 Mbps upload demand)
- No unit test infrastructure — high-value additions would be `logic_service` and `motion_tracker` tests
- "Tens of FPS" — CPU/Railway ceiling; GPU or on-device inference needed
- Multi-worker scaling — currently assumes single Uvicorn worker (in-memory state)

---

## Contributing

This is a **final-year CS project**. The codebase is feature-complete.

For any modifications:
1. Read the relevant `.md` documentation first
2. Check `core/config.py` for tunable constants before adding new flags
3. Run the dev stack locally and test end-to-end
4. Push to `main` (all tests must pass in CI)

---

## Team

- **Omer Helfer** — Tean Member
- **Shir Yahav** — Team member
- **Oren Levy** — Team member
- **Liad Lati** — Team member

---

## License & Attribution

This project is an academic final-year submission. Reuse by explicit permission only.

**Special thanks:**
- Ultralytics for YOLOv8
- MongoDB for Atlas hosting
- Google Cloud Platform for compute resources

---

## Contact & Support

For questions or issues with this project:
- **Team email:** seesense.noreply@gmail.com
- **Deployment issues:** See `Server/DEPLOYMENT.md`
- **API details:** See `Server/SERVER.md`
- **Frontend issues:** See `Client/CLIENT.md`

---

**Last updated:** 2026-08-08  
**Status:** Production-ready (GCP deployment active)  
**Branch:** `main`
