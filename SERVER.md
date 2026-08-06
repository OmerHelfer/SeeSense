# SeeSense — Server Documentation

Complete reference for everything built on the backend side of SeeSense.

---

## 1. What the server is

SeeSense is a smart navigation assistant for blind and visually-impaired pedestrians. The
client streams camera frames from a phone; the server runs object detection on each frame,
tracks objects across frames, decides whether the user is in danger, and pushes the verdict
back in real time so the phone can speak/vibrate an alert.

The backend is a **FastAPI** application that:

- Serves a **WebSocket streaming pipeline** (`/stream/ws`) — the hot path, one JPEG in → one
  detection verdict out, at up to ~40 frames/sec.
- Runs a **custom fine-tuned YOLOv8 model** (14 urban-obstacle classes) through Ultralytics.
- Adds a **ByteTrack-inspired multi-object tracker** so the same real-world object keeps a
  stable ID across frames, which enables motion analysis (approaching / moving away / speed).
- Implements **motion-first danger logic** — only objects actively closing distance raise a red
  alert, so a static scene goes quiet instead of screaming every frame.
- Provides the whole **application backend**: users, JWT auth, 3-level admin system, per-user
  settings, detection history, a two-axis feedback/ticketing system, emergency contacts with
  email verification, an SOS alert flow, and a full performance-metrics subsystem with
  persistent per-minute history.
- Persists everything in **MongoDB Atlas**, sends mail through **Gmail SMTP**, and deploys as a
  **Docker** image on **Railway**.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Web framework | FastAPI (ASGI), Uvicorn |
| Real-time transport | WebSocket (binary frames up, JSON down) |
| Model runtime | PyTorch + Ultralytics YOLO |
| Image processing | OpenCV (`opencv-python`), NumPy |
| Tracking maths | SciPy (`linear_sum_assignment` — Hungarian algorithm) |
| Database | MongoDB (PyMongo, `pymongo[srv]`) |
| Auth | PyJWT (HS256) + bcrypt password hashing |
| Validation | Pydantic v2 (`pydantic[email]`) |
| Rate limiting | SlowAPI |
| Country validation | pycountry |
| Email | `smtplib` + Gmail app password |
| Config | python-dotenv |
| Container | `python:3.11-slim` + `libgl1`, `libglib2.0-0` for OpenCV |
| Hosting | Railway (binds injected `$PORT`) |

`requirements.txt` also carries `motor`, `websockets` and `requests`; `websockets`/`requests`
are used by the interactive test client, `motor` is a leftover from an evaluated async-Mongo
path (the app uses synchronous PyMongo).

---

## 3. Directory layout

```
Server/
├── main.py                     # app factory, lifespan, logging, CORS, rate limiting,
│                               # root/health/system-status/reset endpoints
├── Dockerfile                  # deployment image
├── requirements.txt
├── .env                        # SECRET_KEY, MONGODB_URI, EMAIL_ADDRESS, EMAIL_PASSWORD
│
├── core/
│   ├── config.py               # every tunable constant in one place
│   ├── database.py             # single shared Mongo client + index/TTL bootstrap
│   └── auth.py                 # JWT create/verify, blacklist, admin-level guards
│
├── api/                        # HTTP + WebSocket routers
│   ├── stream.py               # ⭐ the real-time WebSocket pipeline
│   ├── inference.py            # supported classes, pause/resume detection
│   ├── settings.py             # per-user preferences CRUD + validation
│   ├── users.py                # auth, profile, history, feedback, contacts, SOS
│   └── admin.py                # admin user management + feedback triage
│
├── services/                   # business logic (no FastAPI imports on the hot path)
│   ├── vision_service.py       # decode, quality gates, letterbox resize
│   ├── logic_service.py        # danger assessment / alert classification
│   ├── motion_tracker.py       # ByteTrack-style tracker + motion analysis
│   ├── session_service.py      # sessions, in-memory cache, danger-clear, alert dedup
│   ├── user_service.py         # users, history, feedback, contacts, SOS, admin ops
│   ├── email_service.py        # 12 transactional HTML email templates
│   ├── presence.py             # in-memory "who is online right now"
│   └── perf_history.py         # persistent per-minute performance rollups
│
├── ml_engine/
│   ├── model_loader.py         # device detection, 3 load modes, inference + parsing
│   └── seesense_model.pt       # ⭐ the fine-tuned weights (6 MB, shipped in the image)
│
├── schemas/
│   ├── user.py                 # Pydantic request/response models
│   └── payload.py              # detection/motion/response models
│
├── utils/
│   └── metrics.py              # live PerformanceTracker (sliding windows)
│
├── tests/
│   └── test_ws.py              # interactive WebSocket test client (images + video)
│
├── yolov8n.pt                  # stock pretrained weights (for "pretrained" mode)
└── logs/                       # rotating log files (gitignored)
```

---

## 4. Configuration (`core/config.py`)

Everything tunable lives here, grouped by concern.

### Model
| Constant | Value | Meaning |
|---|---|---|
| `MODEL_PATH` | `ml_engine/seesense_model.pt` | Fine-tuned weights |
| `MODEL_MODE` | `"custom"` | `mock` \| `pretrained` \| `custom` |

### Preprocessing / streaming
| Constant | Value | Meaning |
|---|---|---|
| `TARGET_SIZE` | 640 | Fallback square input size when the client sends none |
| `MIN_INPUT_SIZE` / `MAX_INPUT_SIZE` | 160 / 640 | Clamp for the client-requested `input_size` |

There is **no frame-rate constant**. `TARGET_FPS` / `MAX_FPS` were removed in 2026-08: the send rate
is governed entirely by the client's `MAX_INFLIGHT`, which self-throttles to roughly `depth / RTT`.

### Inference
| Constant | Value |
|---|---|
| `CONFIDENCE_THRESHOLD` | 0.4 |
| `NMS_IOU_THRESHOLD` | 0.45 |

### Danger logic — sensitivity profiles
Each user picks a sensitivity; the profile overrides the confidence floor and the bbox-area
ratios used to classify distance:

| Profile | conf. threshold | close ratio | medium ratio |
|---|---|---|---|
| `low` | 0.70 | 0.40 | 0.25 |
| `medium` (default) | 0.50 | 0.15 | 0.05 |
| `high` | 0.35 | 0.08 | 0.03 |

### Classes (14)
`person, car, bicycle, motorcycle, bench, fire_hydrant, traffic_light, stairs, pole, dog,
bollard, crosswalk, pothole, scooter`

`HIGH_RISK_CLASSES` default (9) = `car, motorcycle, bicycle, person, stairs, dog, bollard,
pothole, scooter` — i.e. everything except `bench`, `fire_hydrant`, `traffic_light`, `pole` and
`crosswalk`. Users can override this list per account.

### Frame quality gates
`DARK_IMAGE_THRESHOLD = 25`, `MIN_IMAGE_BYTES = 1000` (plus the thresholds inside
`vision_service.py`: `BLUR_THRESHOLD = 50.0`, `OVEREXPOSED_THRESHOLD = 240`,
`UNIFORM_STD_THRESHOLD = 10`, `MIN_RESOLUTION = 120`).

### Default user settings
```python
{
  "alert_type": "both",            # audio | haptic | both
  "volume_intensity": 0.8,
  "vibration_intensity": 0.8,
  "voice_gender": "default",       # female | male | default
  "detection_sensitivity": "medium",
  "high_risk_classes": [...]
}
```

### Other
- `VALID_PERIODS` — history filters: `all, today, week, month, three_months, half_year, older`
- `VALID_FEEDBACK_TYPES` — `wrong_detection, missed_obstacle, general`
- `CORS_ORIGINS` — localhost:3000/5173/8080, `seesense.app`, the Railway client URL, plus
  anything added via the comma-separated `CORS_ORIGINS` env var (so production origins need no
  code change)
- JWT: `HS256`, `JWT_EXPIRATION_HOURS = 24`, secret from `SECRET_KEY`
- Mongo: URI from `MONGODB_URI`, database name `seesense`

---

## 5. Startup and app wiring (`main.py`)

The order of operations in `main.py` matters and is deliberate:

1. **`YOLO_AUTOINSTALL=false` is set before any Ultralytics import.** Ultralytics otherwise
   tries to `pip install` missing optional dependencies at runtime — unacceptable in a serving
   process.
2. **Maths thread pools are capped before torch/NumPy/OpenCV are imported** (`OMP_NUM_THREADS`,
   `MKL_NUM_THREADS`, default 8, disable with `TORCH_NUM_THREADS=0`). Reason: a container's
   cgroup limits how much CPU it may *use* without changing the core count it *sees*. Railway
   reported `os.cpu_count() == 48` while the replica limit was 8 vCPU, so torch spawned 48
   threads for 8 vCPU of work — 6× oversubscribed, burning time on context switches. A
   controlled sweep measured 16 threads running **4× slower** than 8 on a 16-core machine.
   `model_loader.py` additionally calls `torch.set_num_threads()` as a belt-and-braces measure
   for entry points that import torch first (tests, scripts, a different ASGI runner).
3. **Logging** — INFO level, console + `RotatingFileHandler` (`logs/seesense.log`, 5 MB × 5
   backups, UTF-8).
4. **Lifespan startup**: connect Mongo → run `migrate_admin_levels()` → load the model into
   `app.state.model` → record `app.state.start_time`. Shutdown closes the Mongo client.
5. **Rate limiting** — SlowAPI `Limiter(key_func=get_remote_address)` on `app.state.limiter`
   with a custom 429 handler returning `{"detail": "Too many requests. Please slow down."}`.
6. **CORS** — `allow_origins=CORS_ORIGINS`, credentials on, all methods/headers.
7. **Routers included**: inference, settings, stream, users, admin.

### Endpoints defined directly in `main.py`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | — | Liveness string |
| GET | `/health` | — | Lightweight ping: `{status, model_mode, uptime_seconds}`. The client's health watchdog polls this every 5 s to measure RTT. |
| GET | `/get_system_status` | admin (L1+) | Performance metrics over **all** recorded history (the time-range parameters were removed — the per-minute buckets already cover the retention period, so a lookback only ever narrowed what was shown). No `email` → totals across every user; `email=<addr>` → that user's own totals. A sync `def` on purpose: everything it does is blocking pymongo, and as `async def` one admin poll stalled the event loop serving a live streaming WebSocket. |
| POST | `/reset_system_status` | super admin (L2) | No `email` → wipes everything: live windows *and* every user's persisted history. `email=<addr>` → only that user's persisted history (deliberately leaves the live tracker alone; it is process-wide and clearing it would destroy everyone else's). Irreversible. |

---

## 6. Authentication and authorisation (`core/auth.py`)

- **Tokens** — JWT HS256, payload `{user_id, email, exp, iat}`, 24 h lifetime.
- **Passwords** — bcrypt with per-password salt (`bcrypt.hashpw` / `checkpw`). Hashes never
  leave the service layer (`_safe_profile` strips `password_hash` and `_id`).
- **Logout revocation** — a real blacklist. `blacklist_token()` inserts the token into the
  `blacklisted_tokens` collection; `verify_token` rejects anything found there. A TTL index on
  `created_at` expires entries after the JWT lifetime, so the collection self-prunes.
- **Presence side-effect** — every successful `verify_token` stamps `presence.mark_active(user_id)`.
  That is how "who is online" stays accurate for users browsing the app without scanning.
- **Three admin levels**, stored as `admin_level` on the user document:

| Level | Name | Can do |
|---|---|---|
| 0 | regular user | own data only |
| 1 | admin | view everything; manage **regular** users (edit details, set password); triage feedback |
| 2 | super admin | everything: delete users, grant/revoke admin levels, reassign feedback, reset performance data |

  Guards: `verify_token` → `verify_admin` (level ≥ 1) → `verify_super_admin` (level 2). Each
  attaches `admin_level` to the returned user dict so endpoints and the UI can gate actions.
  `get_admin_level()` falls back to the legacy `is_admin` boolean (`True` → 2) for any document
  not yet migrated.
- **Lockout protection** — you cannot demote or delete the *last* remaining level-2 admin, and
  a super admin cannot demote or delete their own account from the admin panel.
- **WebSocket auth** is separate (`_authenticate_ws` in `api/stream.py`) because FastAPI's
  `Depends`/`HTTPBearer` isn't available on a WS handshake. The token arrives as a query
  parameter, gets the same blacklist + signature checks, and a failure closes the socket with
  a specific code: **4001** = missing token, **4003** = invalid/expired token.

---

## 7. Database (`core/database.py`)

A single module-level `MongoClient` shared by the whole app. `connect()` runs once at startup,
pings the server, and ensures indexes.

### Collections

| Collection | Contents | Key fields |
|---|---|---|
| `users` | Profiles. Emergency contacts are **embedded** as an array inside the user document. | `user_id` (8-char uuid slice), `email` (lower-cased canonical), `password_hash`, `admin_level`, `is_admin`, `emergency_contacts[]`, `last_seen`, `created_at` |
| `settings` | One document per user, upserted | `user_id` + the six setting keys |
| `sessions` | One scan session | `session_id` (uuid4), `user_id`, `status` (`active`/`stopped`), `started_at`, `stopped_at`, `frame_count`, `paused` |
| `detection_history` | One document per processed frame | `_id` (pre-generated), `user_id`, `session_id`, `timestamp`, `danger`, `alert_level`, `distance`, `objects_detected`, `objects[]` (class/confidence/distance summaries) |
| `feedback` | User reports + admin triage state | `user_id`, `feedback_type`, `record_id`, `session_id`, `detection_snapshot`, `notes`, `status`, `handling_status`, `handling_admin_id/name`, `admin_response`, `response_seen`, timestamps |
| `emergency_alerts` | SOS history | `alert_id`, `user_id`, `user_name`, `gps{lat,lon}`, `google_maps_link`, `timestamp`, `notified_contacts[]` |
| `blacklisted_tokens` | Revoked JWTs | `token`, `created_at` — **TTL 24 h** |
| `reset_codes` | Password-reset codes | `email`, `code`, `created_at` — **TTL 15 min** |
| `perf_history` | Per-minute performance rollups | `minute_ts` (indexed), `created_at` — **TTL ~400 days**, `lat`, `rtt`, `frames`, `success`, `fail`, `stages{}` |

TTL indexes mean expiry is enforced by MongoDB, not application code — reset codes and
revoked tokens disappear on their own.

### Email canonicalisation
`_norm_email()` lower-cases and trims every email on register, login, admin lookup and
password reset, so `OmErHelFER@Gmail.com` and `omerhelfer@gmail.com` are the same account.

---

## 8. The real-time pipeline (`api/stream.py`) ⭐

This is the core of the project.

### Handshake

```
ws://host/stream/ws?token=<JWT>&input_size=512
```

1. No token → close 4001. Bad/blacklisted token → close 4003.
2. `input_size` is a *request*: clamped to `[MIN_INPUT_SIZE, MAX_INPUT_SIZE]`. The clamped
   value is used for both letterboxing and YOLO inference, and is echoed back so client and
   server agree on the bbox coordinate space.
3. `get_or_create_session(user_id)` — see session resume below.
4. User settings are fetched **once** and put in the in-memory cache. This is the only DB read
   at connect time and there are **zero settings reads per frame**.
5. Server sends:
   ```json
   { "type": "connected", "session_id": "...",
     "input_size": 512, "message": "Stream session active" }
   ```
   The client uses `input_size` to size its capture canvas and to interpret bbox coordinates.
   No frame-rate is negotiated — the client's `MAX_INFLIGHT` alone governs the rate.

### Message types

**Client → server**
- **binary** — a JPEG frame to analyse.
- **text JSON**:
  - `{"type":"rtt_report","rtt_ms":48.5}` — client-measured end-to-end round trip (validated `0 < rtt < 30000`).
  - `{"type":"fps_report","fps":21.4}` — actual client capture rate (validated `0 < fps < 100`).
  - `{"type":"client_stage_report","stages":{...}}` — client-side per-stage timings
    (capture/encode/render/feedback), already aggregated to avg/min/max.
  - `{"type":"lost_report","lost":3}` — frames the client sent that never received a reply, as a
    **delta** since its last report (validated `0 < lost < 100000`). Only the client can know this;
    the server cannot count what never reached it. Should normally be 0 — WebSocket runs over TCP,
    so the realistic causes are a socket that broke with frames in flight, or a server stalled past
    the client's 3s in-flight timeout.

**Server → client**
```json
{
  "type": "result", "status": "success", "frame": 128,
  "record_id": "68c...",          // returned immediately; the DB insert happens after
  "latency_ms": 41.2,
  "danger": true,
  "danger_cleared": false,        // true only when every engaged track has LEFT — see evaluate_presence
  "clearance_message": null,      // "Path Clear" when danger_cleared
  "static_notice": null,          // {class_name, position} — present but motionless; client says "אין תנועה"
  "alert_is_new": true,           // gates TTS/haptic — see alert dedup
  "alert_level": "high",          // high | low | none
  "distance": "Close",            // Close | Medium | Far
  "objects": [ { class_name, confidence, bbox, area_ratio, distance, position,
                 alert_level, alert_message, watched, motion{...} } ]
}
```
`watched` = the class is in the user's `high_risk_classes`. Distinct from `alert_level != "none"`:
a watched object standing still is `"none"` too. Presence tracking needs both.
Also `{"type":"result","status":"paused","frame":N}` when detection is paused, and
`{"type":"error","frame":N,"detail":"...","danger_cleared":...}` for rejected frames.

### Per-frame stages (each timed and reported)

| Stage | What happens |
|---|---|
| `decode_quality` | `decode_image()` — size check, `cv2.imdecode`, resolution check, letterbox resize to the connection's input size, then four quality gates. |
| `inference` | YOLO forward pass, run via `asyncio.to_thread` so it never blocks the event loop, wrapped in a **global `threading.Lock`** so only one inference executes at a time. |
| `tracking` | Per-user `ByteTracker.update()` assigns/updates track IDs and computes motion. |
| `danger_logic` | `assess_danger()` with the user's cached sensitivity + high-risk class list. |
| `db_write` | `build_detection_entry()` only — builds the document with a **pre-generated `ObjectId`**. No I/O. |

After the JSON response is sent, two **daemon threads** fire off the actual writes:
`insert_detection_entry(entry)` and `save_frame_count_background(session_id, frame_count)`.
Neither can stall the stream, and a failed write can't crash it.

### Why the event loop matters
Inference runs in a worker thread on purpose. If it ran inline, a ~40 ms forward pass would
block the async loop, which would stall the `/health` pings — and the client's connection
watchdog would falsely report the connection as unstable and go RED. The same reasoning drove
moving all SMTP sends onto background threads (see §14).

### Concurrency model
Ultralytics YOLO isn't guaranteed thread-safe for concurrent forward passes, and the hardware
can only do one efficiently anyway. So: many concurrent WebSocket connections, but inference is
serialised behind `_inference_lock` while the event loop stays responsive.

### Cleanup on disconnect
`clear_cache(user_id)` (also stamps `last_seen`), `clear_tracker(user_id)`, `stop_session(session_id)`.

### Error handling
- `ValueError` (a failed quality gate) → `type: "error"` with the human-readable reason, and
  `danger_cleared` is still evaluated so a user who moved away still hears "Path Clear".
- Any other exception → logged with traceback, generic `"Internal processing error"` to the
  client. Failures are counted in both the live tracker and the persisted history.

### Other stream endpoint
`GET /stream/session_status` — current session's id, start time, frame count and paused flag.

---

## 9. Vision service (`services/vision_service.py`)

`decode_image(bytes, target_size)` pipeline:

1. Reject payloads under `MIN_IMAGE_BYTES` (1000) — empty or corrupt.
2. `cv2.imdecode`; `None` → "Failed to decode image".
3. Resolution check on the **original**: longest side must be ≥ 120 px.
4. **Letterbox resize** to a `target_size × target_size` square, aspect ratio preserved, padded
   with grey 114 — the standard YOLO preprocessing, so nothing is distorted.
5. Quality gates on the **resized** image (much cheaper than on a 2048×1536 original):

| Gate | Condition | Message to the user |
|---|---|---|
| Camera covered | grey std-dev < 10 | "Camera appears to be covered or blocked." |
| Too dark | mean intensity < 25 | "Image is too dark…" |
| Overexposed | mean intensity > 240 | "Image is overexposed…" |
| Blurry | Laplacian variance < 50 | "Image is too blurry…" |

`process_image()` (BGR→RGB→CHW→normalise→batch, returning a `(1,3,640,640)` tensor) exists for
the raw-PyTorch model path but is currently **not used** — the Ultralytics path takes the
letterboxed image directly (the call site in `stream.py` is commented out).

---

## 10. ML engine (`ml_engine/model_loader.py`)

- **Device** — `cuda` if available, else `cpu`. On CPU, `torch.set_num_threads()` applies the
  thread cap.
- **`log_runtime_config()`** is called from `load_model()` rather than at import time, because
  this module is imported *before* `logging.basicConfig()` runs, when the root logger is still
  at WARNING — INFO logs there would be silently discarded. (This was an actual bug: "runtime-
  config diagnostics never appeared in the logs".) It reports device, torch intra-op/inter-op
  thread counts, `os.cpu_count()` and `OMP_NUM_THREADS`.
- **Three load modes**:
  - `mock` — `MockModel` returns no detections; lets the whole stack run with no weights file.
  - `pretrained` — stock `yolov8n.pt` from Ultralytics.
  - `custom` — `YOLO(MODEL_PATH)` with the fine-tuned `seesense_model.pt`.
- **`run_inference(model, img, imgsz)`** dispatches on model type and always returns detections
  **in the input image's coordinate space**, so the client overlay stays correct at any `imgsz`.
  `imgsz` is the single biggest inference-speed lever.
- **Result parsing** — `parse_ultralytics_results()` converts boxes to
  `{class_name, confidence, bbox}`, normalises names (spaces → underscores) and **drops any
  class not in `CLASS_NAMES`**, so a pretrained model's 80 COCO classes are filtered down to the
  14 the app cares about. `parse_raw_detections()` handles a raw `[N, 6]` tensor for the
  pure-PyTorch path.

---

## 11. Motion tracking (`services/motion_tracker.py`)

A ByteTrack-inspired tracker, one instance per user (`_user_trackers` dict, cleared on
disconnect).

### `Track`
Auto-incrementing `track_id`, class, confidence, bbox, lifecycle counters (`age`, `hits`,
`time_since_update`), and a `deque` of the last 10 frames' `{bbox, area, center}`.

### Two-stage association (`ByteTracker.update`)
1. Split detections at `HIGH_CONF_THRESHOLD = 0.5`.
2. **Stage 1** — match high-confidence detections to existing tracks: build an IoU matrix,
   solve with the Hungarian algorithm (`scipy.optimize.linear_sum_assignment` on `1 - IoU`),
   keep pairs with IoU ≥ `IOU_THRESHOLD = 0.3`.
3. **Stage 2** — match leftover *low*-confidence detections to still-unmatched tracks. This is
   the ByteTrack insight: it stops a track dying just because the object was briefly occluded
   and its confidence dipped.
4. Unmatched high-confidence detections spawn new tracks; tracks unseen for more than
   `MAX_AGE_SECONDS = 1.2` are removed.
5. Every detection is returned enriched with its track's `motion` block.

### Trend-based motion analysis (`Track.get_motion` → `_size_trend`)

**Every timing here is a DURATION, never a frame count.** Frame counts were tuned at ~4 FPS and
silently became 10× tighter once the pipeline reached 40; the frame rate varies with the network,
so a frame-count window would mean something different on every connection.

Fits a **least-squares line through `sqrt(area)`** over `APPROACH_WINDOW_SEC = 0.8` (needs at least
`APPROACH_MIN_SAMPLES = 5` samples). `sqrt(area)` because apparent size ∝ 1/distance, which makes
the trend linear for constant closing speed — raw area curves, and a curved signal fits a line badly
exactly when the object is nearest.

The old magnitude test ("did the box grow ≥22% between two moments") was **distance-dependent**: the
same walking speed grows the box 13% at 10m but 56% at 3m, so it was blind to anything approaching
from a distance. A measured case: a dog approached continuously for **5.2s** before it fired.

| Output | Rule |
|---|---|
| `approaching` latches ON | `growth ≥ ENTER_GROWTH` (0.045) **and** `snr ≥ ENTER_SNR` (2.2), held for `CONFIRM_SEC` (0.30s) |
| `approaching` latches OFF | `growth < EXIT_GROWTH` (0.015) **or** `snr < EXIT_SNR` (1.0), held for `RELEASE_SEC` (0.25s) |
| `speed = "fast"` | growth rate ≥ `1 / RAPID_TIME_TO_CONTACT_SEC` — i.e. **time-to-contact under 3s** |
| `direction` | horizontal centre shift > `LATERAL_THRESHOLD` (15 px) → `right`/`left`, else `center` |

- **`snr` = `|change| / resid_rms`** — jitter is large but *uncorrelated*, so it inflates the
  residual without tilting the line, while a slow steady approach tilts it consistently. This is
  what lets a slow approach be seen even when each single frame moves less than the noise.
- Hysteresis + confirm/release timers stop the verdict chattering across a single threshold.
- An unconfirmed track (`MIN_HITS = 3`) or an under-sampled window reports no motion at all.
- Reported boxes are EMA-smoothed (`BBOX_SMOOTHING = 0.4`), which steadies both the distance class
  and the client overlay — but also makes consecutive samples **correlated**, which matters if
  anyone tries to make the confidence gate sample-count-aware (that was attempted and rejected;
  the measured result is in the knowledge doc §10u).

---

## 12. Danger logic (`services/logic_service.py`)

`assess_danger(detections, high_risk_classes, sensitivity, image_width, image_height)`:

1. Load the sensitivity profile; drop detections below its confidence threshold.
2. `area_ratio = bbox_area / frame_area` → **distance**: `Close` if ≥ close ratio, `Medium` if
   ≥ medium ratio, else `Far`. (Bounding-box area is the depth proxy — no depth sensor needed.)
3. **Position** from bbox centre: frame split into thirds → `left` / `center` / `right`.
4. **Alert level** per object (see below).
5. **Alert message** for TTS, e.g. `"car approaching fast on your right"`,
   `"person nearby ahead"`, `"dog detected on your left"`.
6. Roll up to a frame verdict: highest alert level, closest distance, and
   `danger = (highest_alert == "high")`.

### Motion-first alert classification (`_classify_alert`)

This is the design decision that makes the app usable rather than exhausting:

**Not approaching** (static or moving away) → never red.
- A high-risk, **non-vehicle** obstacle (person/dog/pole/stairs…) at `Close` → `low` (a soft
  caution).
- Vehicles and anything farther → `none`, fully silent.

**Approaching** → escalate:
- High-risk + `speed == "fast"` → `high` at any distance.
- High-risk + `Close`/`Medium` → `high`.
- High-risk + `Far` → `low` (early heads-up).
- Not high-risk + `Close` → `high`; `Medium` → `low`; else `none`.

Net effect: parked cars, shelves, a standing person, or the user sitting still all go quiet. The
red screen clears when relative motion stops and only re-fires on a genuinely new approach. And
because the user walking *toward* something grows its bbox, that also reads as "approaching" —
which is correct.

---

## 13. Sessions, caching and dedup (`services/session_service.py`)

### In-memory cache
`_user_cache: user_id → {paused, settings, session_id}`. Written on WS connect, on
pause/resume, and on settings update. Read on **every frame** instead of hitting Mongo — the
comment in the code records the measured difference: **0 ms vs 71 ms per frame**. Presence
("is this user connected") is derived from cache membership.

### Session resume
`get_or_create_session()`:
1. An `active` session exists → reuse it.
2. A `stopped` session exists whose `stopped_at` is within **15 minutes** → reactivate it (so a
   dropped connection or a short break doesn't fragment history into many sessions).
3. Otherwise create a new one.

### Clearance and static obstacles — `evaluate_presence()`

`evaluate_presence(user_id, objects) -> {"danger_cleared", "static_notice"}` decides what to say
about what is in front of the user, based on whether objects are still **there** — not on whether
they are currently alerting.

**Why not the alert level (this replaced `check_danger_cleared`, which is no longer on the path):**
a watched object that stops moving scores `alert_level == "none"`, which is byte-identical to an
empty frame. Deriving "path clear" from that announced **"נתיב פנוי" at a person standing still in
front of a standing user** — the most dangerous sentence this app can produce.

| output | rule |
|---|---|
| `danger_cleared` | `True` only when **every** engaged track has aged out (`_PRESENCE_TTL = 1.5s`) — the object genuinely left |
| `static_notice` | `{class_name, position}` for a watched object, near enough to matter, motionless for `_STATIC_CONFIRM_SEC = 0.8s`. The client speaks it as "אדם לפניך, אין תנועה" |

- `static_notice` fires **once per still episode**, re-armed if the object starts moving again.
- A quality-rejected frame calls `evaluate_presence(user_id, [])` — withholding a refresh rather
  than asserting departure, so a blurry second cannot fake an all-clear.
- Objects at `distance == "Far"`, and classes not in the user's `high_risk_classes`, never engage
  and never speak.

Depends on `logic_service` tagging each object with **`watched`** (`class_name in high_risk_classes`).
That flag cannot be inferred from `alert_level`, because a watched object standing still is `"none"`
too — and "not dangerous right now" vs "not something you asked about" is exactly the distinction.

### Alert dedup
`has_new_alert(user_id, objects)` keeps the last announced alert level **per `track_id`** and
returns `True` only when some object's level genuinely changed (`none → low`, `low → high`).
Without it, a car sitting at `low` for ten seconds would re-fire TTS and haptics on all ~200
frames. Tracks absent from the current frame are forgotten, so if the same real-world object
reappears later it *is* treated as new — which is the desired behaviour.

### Background writes
`save_frame_count_background()` runs the session frame-count update on a daemon thread and
swallows errors.

---

## 14. Presence (`services/presence.py`)

A deliberately simple in-memory map `user_id → last-activity timestamp`, with
`ONLINE_THRESHOLD_SECONDS = 90` (≈ three missed 30 s heartbeats).

Activity is stamped from three places: any authenticated HTTP request (via `verify_token`), the
client's periodic `POST /users/heartbeat`, and the streaming WebSocket (on connect and on every
frame). This is intentionally **not** tied to the scanning socket alone — a logged-in admin
browsing the dashboard should read as online.

In-memory means it resets on restart, at which point everyone reads offline until their next
request. The durable `last_seen` field on the user document still supplies "offline since X"
across restarts.

*(Note: `session_service` also exposes a `get_online_user_ids()` derived from the WS cache. The
admin views use the `presence` module's version.)*

---

## 15. Performance metrics

Two layers, because the requirements are different.

### Live: `utils/metrics.py` — `PerformanceTracker`
A single global instance with sliding windows (`deque(maxlen=100)`):
- Server-side per-frame latency (avg/min/max)
- Client-reported end-to-end RTT (avg/min/max) + a 60-point timestamped history for the live chart
- Frame arrival timestamps → real server FPS
- Client-reported capture FPS
- **Throughput** — completion timestamps of *successful* frames over a rolling 10-second
  wall-clock window. Unlike the FPS numbers this decays to 0 when idle, so it reflects "how many
  detections per second are flowing right now" rather than being diluted by long gaps between
  test bursts. The rate is derived from `(n-1)/(t_last - t_first)` so it reads correctly
  immediately, with no warm-up ramp.
- Per-stage server latency breakdown
- Latest client-side stage breakdown — validated and clamped, since it is untrusted client
  input (max 16 stages, name truncated to 32 chars, values must be `0 ≤ x < 60000`)
- Four different FPS numbers, because they answer different questions:
  `server_capacity` (theoretical, `1/avg_latency` — over **`success_latencies` only**),
  `server_actual` (frames actually arriving), `client_actual` (what the phone reports sending),
  `overall` (total frames / uptime)
  > ⚠️ `server_capacity` must never be computed from the all-frames `latencies` window. A quality
  > reject is abandoned ~2.8ms after decode without ever running inference, so mixing rejects in
  > drags the average toward zero and the reciprocal explodes — this reported **~351 FPS** from a
  > server doing ~40. Capacity means "how fast can it process a frame"; a frame it refused to
  > process is not evidence about that.
- `reset()` clears everything and restarts timing

### Persistent: `services/perf_history.py`
The live tracker resets on restart, so time-range analytics needs storage. Metrics accumulate
into a **minute-aligned bucket**; when the minute rolls over, the completed bucket is flushed to
`perf_history` on a daemon thread (`replace_one(..., upsert=True)` keyed by `minute_ts`, so no
double counting). `flush_now()` persists the in-progress partial minute before a range query so
the newest data is included.

Bucket shape: `{minute_ts, created_at, lat{sum,min,max,n}, rtt{...}, frames, success, fail,
stages{name: {...}}}`.

`query_range(start, end)` aggregates buckets into a payload shaped like the live status (minus
the live-only RTT chart), computing span-based overall FPS and throughput. Retention is ~400
days via TTL, so a "last year" range always has data. Recording is forward-only — there is no
retroactive history — and `reset_history()` drops everything.

---

## 16. Users API (`api/users.py`, prefix `/users`)

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/register` | Creates the account, returns profile + JWT, sends a welcome email in the background |
| POST | `/login` | **Rate-limited 10/min per IP.** Returns profile + JWT, stamps `last_seen` and presence |
| POST | `/heartbeat` | Presence ping (the work happens in `verify_token`) |
| POST | `/logout` | Blacklists the current token |
| DELETE | `/account` | Self-delete. Blocked for the **last super admin**. Notifies verified emergency contacts *and* the user by email, deletes all data, blacklists the token |

### Passwords
| Method | Path | Notes |
|---|---|---|
| POST | `/change_password` | Requires the old password; min 6 chars; confirmation email |
| POST | `/forgot_password` | **Rate-limited 3/min.** Generates a 6-digit code stored under the canonical (lower-cased) email with a 15-min TTL. **Always returns the same success message** whether or not the email exists — no account enumeration |
| POST | `/reset_password` | Validates the code, force-changes the password, deletes the code, sends a confirmation |

### Profile
`GET /profile` (adds a `contacts_summary` with total/verified/pending/max_allowed),
`POST /profile/update` (typed `UpdateProfileRequest` with `extra: forbid`; sends a
"profile updated" email).

### History
`GET /history?limit&period&session_id` (period validated against `VALID_PERIODS`),
`DELETE /history/{record_id}`, `DELETE /history` (clear all, returns the count).

### Feedback
| Method | Path | Purpose |
|---|---|---|
| POST | `/feedback/quick` | One-tap report during a walk. Optionally linked to a `record_id`; captures a **detection snapshot** so the frame's context survives even if the history record is later deleted. Rejects duplicates for the same record. Status `pending`. |
| POST | `/feedback/from_history` | Report created from a specific history record, with notes. Status `submitted`. |
| POST | `/feedback/general` | Standalone report, not tied to a detection. `submitted` if notes were given, else `pending`. |
| GET | `/feedback/pending` | Reports awaiting the user's own notes |
| GET | `/feedback/all` | All of the user's reports, including admin handling status and response |
| POST | `/feedback/{id}/update` | Add notes / change type → marks `submitted`. **409 once an admin is handling it** |
| POST | `/feedback/{id}/submit` | Submit a pending report as-is |
| DELETE | `/feedback/{id}` | Delete |
| GET | `/feedback/responses/unseen_count` | Badge count of unread admin responses |
| POST | `/feedback/responses/seen` | Clear the badge |

### Emergency contacts
`POST /contacts/add`, `POST /contacts/verify`, `POST /contacts/resend_code`,
`DELETE /contacts/remove`, `GET /contacts`. See §17.

### SOS
`POST /users/emergency_alert` (body `{gps_lat, gps_lon}`) and `GET /users/emergency_alerts`
(newest first, max 50).

---

## 17. Emergency contacts — the verification state machine

Contacts are **embedded** in the user document, capped at `MAX_EMERGENCY_CONTACTS = 5`.

Adding a contact:
1. Expired pending contacts are cleaned up first; the user is emailed about each removal
   (on a background thread — blocking SMTP here would freeze the event loop).
2. Guards: user must exist, you can't add yourself, no duplicate email, cap not exceeded.
3. A 6-digit code is generated, the contact is stored with `status: "pending"`,
   `code_expires` = now + **30 minutes**, `code_attempts: 0`.
4. The **contact** (not the user) is emailed the code, along with an explanation of what
   SeeSense is and what being an emergency contact means. They share the code with the user.

Verifying: rejects an already-verified contact, more than `MAX_CODE_ATTEMPTS = 3` failures, an
expired code, or a wrong code (which increments the attempt counter and reports how many
attempts remain). On success the code fields are cleared, `verified_at` is stamped, and **both**
parties get a confirmation email.

`resend_contact_code` issues a fresh code and resets the attempt counter.
`_cleanup_expired_contacts()` runs on add / verify / resend / list, so expired pending contacts
never linger. Removing a *verified* contact emails them that they no longer receive alerts.
Only verified contacts receive SOS alerts (`get_verified_contacts`).

### SOS flow (`trigger_emergency`)
1. Requires at least one verified contact, else 400.
2. Builds a Google Maps link `https://maps.google.com/?q=<lat>,<lon>`.
3. Persists the alert with the list of notified contacts (so SOS history is auditable).
4. **Sends every email on a background thread and returns immediately.** This was a real
   production bug — blocking SMTP on the async event loop froze the *entire* server: `/health`
   pings timed out, the client watchdog went RED "connection lost", and every other request and
   WebSocket stalled until all the mail finished sending. Fixed in commit
   "Fix SOS and contact-add freezing the server on email send".

---

## 18. Settings API (`api/settings.py`, prefix `/settings`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/get_settings` | Returns the user's settings, or `DEFAULT_SETTINGS` if none stored |
| POST | `/update_settings` | Partial update, upserted |
| GET | `/available_classes` | The 14 selectable classes |
| POST | `/reset_settings` | Restore defaults |

Every key is validated on write — unknown keys 400; `high_risk_classes` must be a list drawn
from `ALL_CLASSES`; `detection_sensitivity ∈ {low, medium, high}`;
`alert_type ∈ {audio, haptic, both}`; `voice_gender ∈ {female, male, default}`;
intensities must be numbers in `[0.0, 1.0]`.

After a successful write, `update_cache()` refreshes the in-memory copy so a **live WebSocket
picks up the new settings on the very next frame** without reconnecting.

`get_user_settings()` is also the function the stream uses at connect time.

---

## 19. Inference API (`api/inference.py`, prefix `/inference`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/get_supported_objects` | Public list of detectable classes |
| POST | `/pause_detection` | Sets `paused: true` on the active session **and** in the cache, so the WebSocket sees it instantly. 400 if no active session |
| POST | `/resume_detection` | The reverse |

While paused the stream still accepts frames but replies `{"status": "paused"}` without running
the model.

---

## 20. Admin API (`api/admin.py`, prefix `/admin`)

### Permission matrix

| Action | L1 admin | L2 super admin |
|---|---|---|
| View overview / admin list / any user | ✅ | ✅ |
| Edit details / set password of a **regular** user | ✅ | ✅ |
| Edit details / set password of an **admin** | ❌ 403 | ✅ |
| Grant / revoke admin level | ❌ | ✅ |
| Delete a user | ❌ | ✅ |
| Take / resolve feedback | ✅ (own, or any as L2) | ✅ |
| Assign feedback to an admin | ❌ | ✅ |
| Reset performance data | ❌ | ✅ |

Enforced by `_require_can_manage(actor, target)`: a level-1 admin can never act on a user with
`admin_level ≥ 1`. Endpoints also return `actor_level` so the UI can hide what the caller can't
do.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/overview` | Counts: total / online / offline / admins / admins_online, plus `actor_level` |
| GET | `/admins` | All admin accounts with presence and `last_seen` |
| GET | `/user?email=` | Full admin view of one user: profile, level, presence, emergency contacts, and `data_counts` (detections / feedback / sessions / contacts / SOS alerts) |
| POST | `/user/set_password` | Min 6 chars |
| POST | `/user/update` | Only non-null fields, validated by `UpdateUserRequest` |
| POST | `/user/set_level` | L2 only; blocks self-demotion and demoting the last super admin |
| DELETE | `/user` | L2 only; blocks self-delete and deleting the last super admin; cascades all data |
| GET | `/feedback[?handling_status=]` | All *submitted* feedback from all users + status counts. Resolves user names in **one** batched query (`user_map`) instead of one per row |
| POST | `/feedback/{id}/take` | `pending → in_progress` under the caller; fails if already taken |
| POST | `/feedback/{id}/resolve` | Requires a non-empty response note. Only the handling admin or an L2 may resolve. Sets `response_seen: false` (drives the user's badge) and emails the user |
| POST | `/feedback/{id}/assign` | L2 only; assigns to a specific admin → `in_progress` under them. Can't reassign a resolved item |

### The two-axis feedback lifecycle

This is worth spelling out because it's easy to confuse the two fields:

- **`status`** — the *user's* axis: `pending` (needs the user's notes) → `submitted` (sent).
- **`handling_status`** — the *admin* axis, layered on top and completely independent:
  `pending` (ממתין) → `in_progress` (בטיפול) → `resolved` (טופל).

Only `submitted` feedback appears in the admin queue. `handling_status` never touches `status`.
Legacy documents with no `handling_status` read as `pending` via `_norm_handling()`. Once an
admin takes a feedback, the user's edit endpoint returns **409** — the report is locked.

---

## 21. Email service (`services/email_service.py`)

Gmail SMTP (`smtp.gmail.com:587`, STARTTLS, app password), 10-second timeout. If credentials
are missing it logs a warning and returns `False` rather than raising — email is never allowed
to break a request. All twelve senders are HTML templates, and **every call site dispatches
them on a daemon thread** via a local `_send_email_background()` helper.

| Function | Trigger |
|---|---|
| `send_welcome_email` | registration |
| `send_password_changed_email` | change or reset |
| `send_password_reset_email` | forgot-password (contains the 6-digit code) |
| `send_profile_updated_email` | profile edit |
| `send_feedback_response_email` | an admin resolved the user's feedback |
| `send_emergency_contact_verification_email` | contact added / code resent (to the **contact**) |
| `send_emergency_contact_confirmed_email` | contact verified (to the contact) |
| `send_contact_verified_notification` | contact verified (to the user) |
| `send_contact_expired_notification` | pending contact expired |
| `send_emergency_contact_removed_email` | verified contact removed |
| `send_emergency_alert_email` | **SOS** — red-bordered template with a Google Maps button |
| `send_account_deleted_email` / `send_account_deleted_to_contact` | account deletion |

---

## 22. Schemas (`schemas/`)

**`user.py`** — `UserCreate` (`extra: forbid`, with a `pycountry` validator accepting either a
full country name or an ISO alpha-2 code and normalising to the full name), `UserProfile`,
`LoginRequest`, `ChangePasswordRequest`, `ResetPasswordRequest`, `ForgotPasswordRequest`,
`QuickFeedback` / `FeedbackUpdate` / `FeedbackFromHistory` / `StandaloneFeedback` (all with a
`feedback_type` validator), `DetectionRecord`, `UpdateProfileRequest` (`extra: forbid`),
`EmergencyAlertRequest`, and the four contact request models.

**`payload.py`** — `MotionData` (`track_id`, `direction`, `approaching`, `speed`,
`area_change`), `DetectedObject` (class, confidence, bbox, area_ratio, distance, position,
alert_level, alert_message, motion), `AnalyzeFrameResponse` (the documented shape of a frame
verdict, including `danger_cleared`, `clearance_message`, `alert_is_new`).

---

## 23. Deployment

### Dockerfile
`python:3.11-slim` → install `libgl1` + `libglib2.0-0` (OpenCV's native deps; `libgl1` replaces
the renamed `libgl1-mesa-glx` on Debian trixie) → copy `requirements.txt` first for layer
caching → `pip install` → copy the project → expose 8000 → run
`sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --timeout-keep-alive 75"`. Shell form
so an injected `$PORT` is expanded at runtime.

> ⚠️ **`--timeout-keep-alive` must stay well above the client's health-ping interval.** Uvicorn's
> default is **5s** and `healthService.PING_INTERVAL_MS` is **5000** — two timers on the same value,
> racing. Losing the race closes the idle connection, so the next ping pays a full TCP+TLS handshake:
> measured **82ms → 330ms, exactly 3 extra round trips**, on roughly half of all pings, and on every
> session's first ping. It also pushed readings past the watchdog's 200ms red threshold, causing
> false "connection lost" alarms. Set on **both** entrypoints — this Dockerfile and the systemd unit
> in `deploy/setup-vm.sh`.
>
> Note `deploy/update.sh` does **not** regenerate the systemd unit, so an existing VM needs the flag
> applied by hand (or a `setup-vm.sh` re-run) — pulling new code alone will not pick it up.

### Environment variables
| Variable | Purpose |
|---|---|
| `SECRET_KEY` | JWT signing key (falls back to a dev-only default) |
| `MONGODB_URI` | MongoDB Atlas connection string |
| `EMAIL_ADDRESS` / `EMAIL_PASSWORD` | Gmail account + app password |
| `CORS_ORIGINS` | Optional comma-separated extra origins |
| `PORT` | Injected by Railway |
| `TORCH_NUM_THREADS` | Thread cap, default 8; `0` disables the cap |

### `.gitignore` note
`*.pt` is ignored **except** `!ml_engine/seesense_model.pt` — the deployed weights must ship
inside the Docker image.

### Local run
`python main.py` → Uvicorn on `127.0.0.1:8000` with reload.

---

## 24. Performance engineering log

Optimisations, in the order they mattered, with the reasoning preserved:

1. **HTTP per-frame POST → WebSocket streaming.** Removed handshake and header overhead per
   frame; got server latency to ~33 ms.
2. **Settings read per frame → in-memory cache.** 71 ms → 0 ms per frame.
3. **DB write moved off the hot path.** `build_detection_entry()` pre-generates the `ObjectId`
   so `record_id` is returned to the client *before* the insert; the insert runs on a daemon
   thread after the response is sent.
4. **Inference moved to a worker thread** (`asyncio.to_thread`) so the event loop stays free
   and `/health` keeps answering — otherwise the client's watchdog falsely reported an unstable
   connection.
5. **Global inference lock** so concurrent connections don't run concurrent forward passes
   (YOLO isn't guaranteed thread-safe, and the hardware can't do it efficiently anyway).
6. **Configurable input size.** Dropping from 640 to **512** was the single biggest win —
   smaller uploads *and* faster inference — landing around **41 ms/frame**.
7. **Client `toDataURL` → `toBlob`** (async, no base64 round trip). Server-side letterboxing
   and quality checks were also moved to run on the *resized* image.
8. **Thread-pool capping.** The container reported 48 cores while limited to 8 vCPU; torch
   oversubscribed 6×. Capping at 8 fixed it. A sweep showed 16 threads running 4× slower than 8
   on a 16-core box.
9. **The ONNX experiment.** ONNX Runtime benchmarked ~1.5× faster locally, so inference was
   ported to it — and it was **75× slower on Railway** (2323 ms/frame), because of exactly the
   thread-oversubscription problem above. Capping ONNX threads at 8 helped but never beat
   PyTorch on the real server, so ONNX was **removed entirely**. The lesson (measure on the
   deployment target, not the dev box) is now recorded in the code comments.
10. **Windowed motion analysis + per-track alert dedup** — not raw speed, but they removed a
    flood of redundant work and alerts.

Traceable in the git history: `76e5e9c` (WebSocket + cache + background writes),
`ed57ceb` (configurable input size, async DB write), `c47b882` (async `toBlob`),
`43d4ad3`/`5c445b9`/`d3ec807` (ONNX in, out, and gone), `724d18b`/`53165fc` (thread caps),
`a6f2c6a` (the logging fix that made the diagnostics visible).

---

## 25. Testing (`tests/test_ws.py`)

An interactive WebSocket client used for manual pipeline testing. Connects with a pasted JWT,
stays open, and accepts commands: send the next image, send image *N*, `all` (every image in
sequence, for motion testing), `video` (extract every 5th frame from a video and stream them),
`pause`, `resume`, `status`, `quit`.

It simulates the real client faithfully: resizes to 640 and JPEG-compresses at quality 80
*before* timing starts (that work happens on the phone), then measures round-trip time and
separates it into total / server / network via the `latency_ms` the server reports. Prints
per-object detail including track ID, approach flag and speed, and a stats table at the end.

`/tests` is gitignored, so the `test_images/` and `test_videos/` directories are local-only.

---

## 26. Complete endpoint reference

| Method | Path | Auth |
|---|---|---|
| GET | `/` | — |
| GET | `/health` | — |
| GET | `/get_system_status` | admin L1+ |
| POST | `/reset_system_status` | admin L2 |
| WS | `/stream/ws?token=&input_size=` | JWT (query) |
| GET | `/stream/session_status` | JWT |
| GET | `/inference/get_supported_objects` | — |
| POST | `/inference/pause_detection` | JWT |
| POST | `/inference/resume_detection` | JWT |
| GET | `/settings/get_settings` | JWT |
| POST | `/settings/update_settings` | JWT |
| GET | `/settings/available_classes` | JWT |
| POST | `/settings/reset_settings` | JWT |
| POST | `/users/register` | — |
| POST | `/users/login` | — (10/min) |
| POST | `/users/heartbeat` | JWT |
| POST | `/users/logout` | JWT |
| DELETE | `/users/account` | JWT |
| POST | `/users/change_password` | JWT |
| POST | `/users/forgot_password` | — (3/min) |
| POST | `/users/reset_password` | — |
| GET | `/users/profile` | JWT |
| POST | `/users/profile/update` | JWT |
| GET | `/users/history` | JWT |
| DELETE | `/users/history/{record_id}` | JWT |
| DELETE | `/users/history` | JWT |
| POST | `/users/feedback/quick` | JWT |
| POST | `/users/feedback/from_history` | JWT |
| POST | `/users/feedback/general` | JWT |
| GET | `/users/feedback/pending` | JWT |
| GET | `/users/feedback/all` | JWT |
| POST | `/users/feedback/{id}/update` | JWT |
| POST | `/users/feedback/{id}/submit` | JWT |
| DELETE | `/users/feedback/{id}` | JWT |
| GET | `/users/feedback/responses/unseen_count` | JWT |
| POST | `/users/feedback/responses/seen` | JWT |
| POST | `/users/contacts/add` | JWT |
| POST | `/users/contacts/verify` | JWT |
| POST | `/users/contacts/resend_code` | JWT |
| DELETE | `/users/contacts/remove` | JWT |
| GET | `/users/contacts` | JWT |
| POST | `/users/emergency_alert` | JWT |
| GET | `/users/emergency_alerts` | JWT |
| GET | `/admin/overview` | admin L1+ |
| GET | `/admin/admins` | admin L1+ |
| GET | `/admin/user?email=` | admin L1+ |
| POST | `/admin/user/set_password` | admin L1+ (gated) |
| POST | `/admin/user/update` | admin L1+ (gated) |
| POST | `/admin/user/set_level` | admin L2 |
| DELETE | `/admin/user` | admin L2 |
| GET | `/admin/feedback` | admin L1+ |
| POST | `/admin/feedback/{id}/take` | admin L1+ |
| POST | `/admin/feedback/{id}/resolve` | admin L1+ (gated) |
| POST | `/admin/feedback/{id}/assign` | admin L2 |

---

## 27. Known issues and cleanup opportunities

Observations from reading the current code — none are blocking, but they're worth recording:

- **Dead code**: `vision_service.process_image()` is unused (the raw-PyTorch path is commented
  out in `stream.py`). `user_service.add_detection_record()` is imported by `session_service`
  but never called there. `vision_service.is_dark_image()` is superseded by
  `validate_image_quality`.
- **Two presence implementations** — `services/presence.py` (activity-timestamp based, used by
  admin views) and `session_service.get_online_user_ids()` (WebSocket-cache based). Only the
  first is wired into the admin API; the second is effectively unused.
- **In-memory state assumes a single worker.** The settings cache, motion trackers, live metrics
  and presence map all live in process memory. Scaling to multiple Uvicorn workers or replicas
  would need Redis or equivalent.
- **`update_settings(settings: dict = {})`** uses a mutable default argument and an untyped dict
  body; a Pydantic model would validate more cleanly (validation is currently hand-rolled).
- **One Hebrew string leaked into the service layer** — `update_feedback` raises
  `ValueError("המשוב כבר בטיפול…")`, while every other error message is English. Fine
  functionally, inconsistent stylistically.
- **`migrate_admin_levels()` runs on every startup.** It's idempotent and cheap (two
  `update_many` calls on documents missing the field), but it's a one-time backfill that could
  be retired.
- **`_cleanup_expired_contacts()` re-reads the user document** on every contacts-related call
  and issues one `$pull` per expired contact.
- **No automated test suite** — `tests/test_ws.py` is an interactive harness, not assertions.
  Unit tests for `logic_service._classify_alert` and `motion_tracker.get_motion` would be the
  highest-value additions, since both are pure functions encoding the app's core rules.
- **Secrets** live in `Server/.env` (gitignored). The JWT secret falls back to
  `"fallback-secret-for-dev-only"` if `SECRET_KEY` is unset — safe in dev, worth failing loudly
  on in production.
