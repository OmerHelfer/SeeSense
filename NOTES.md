# SeeSense Development Notes

## ✅ Phase 1: Feedback Settings Wiring (Complete)

### What Was Fixed
Settings (volume, vibration, alert_type, voice_gender) were saved to DB but **never used** at runtime. TTS/haptic ignored preferences, used hardcoded values. Mute button and sliders disconnected.

### Changes Deployed

**Server** (`Server/core/config.py`, `Server/api/settings.py`):
- Added `voice_gender` to `DEFAULT_SETTINGS`
- Added validation in `/settings/update_settings`

**Client Store** (`feedbackService.js`):
- Singleton store: `volume_intensity`, `vibration_intensity`, `alert_type`, `voice_gender`
- localStorage mirror for instant availability
- Subscriber pattern for reactive UI
- `seedFeedbackSettings(dbSettings)` on login
- `setFeedbackSettings(patch)` for runtime updates

**Audio (TTS)**:
- `speakMessage()` / `announceDetections()` now use `utterance.volume = volume_intensity`
- Voice selection by gender (female/male/default) with best-effort matching
- `announceMute()` bypasses audio gate ("שמע דלוק"/"שמע כבוי" still heard when mute)
- `previewVoice()` for Settings live preview

**Haptic**:
- `haptic()` scales pulse durations by `vibration_intensity` (0..1)
- Web Vibration API limitation: iOS (WebKit) unsupported; Android works over HTTPS
- Warning note in Settings for iOS users

**SoundToggle**:
- Mute ⇔ volume 0; toggle restores to 0.8
- Unmute logic: if `alert_type === 'haptic'`, switch to `'both'`
- Subscribe to store for icon sync
- Haptic tick + announce on press
- Persist changes to DB

**Settings UI**:
- Subscribe to store for live sync with mute button
- Alert Type toggle: disable one channel (→ 0), restore when re-enabling both (0 → 0.8)
- Volume/Vibration sliders gray-out (disabled) when their channel is off
- New Voice selector (👩 אישה / 👨 גבר / ברירת מחדל) + live preview
- Helper notes: vibration support, voice availability

**Dashboard**:
- SoundToggle moved down (top 116px, below camera bracket)
- Logout confirmation modal ("האם אתה בטוח...?" כן/לא)

**CSS**:
- `.slider-row.disabled`: opacity 0.4, grayscale, no-pointer-events
- `.settings-note`: small inline warnings
- `.confirm-overlay` + `.confirm-card`: logout modal styling

**Commits**:
- `71593f7` Wire feedback settings wiring
- `4425238` Clarify alert_type restoration logic

---

## 📋 Phase 2: Performance & Real-Time (Pending)

### Critical Issues

**1. Backpressure (No Flow Control)**
- Client sends frame every 250ms regardless of server response
- Frames queue up → RTT grows unbounded → latency unreliable
- **Fix:** Send-on-response pattern. Client waits for prior response before sending next frame.
  - Automatic FPS adaptation (system runs at speed server can handle)
  - Honest latency measurement (no queueing distortion)

**2. DB Writes on Hot Path**
- Every frame: `add_detection_record()` DB write **before** sending response
- Adds 50–200ms latency per frame
- **Fix:** Buffer writes, bulk-insert every 1–2s in background
  - Pre-generate `ObjectId` for response immediately
  - Defer bulk write to async task

**3. Model Bottleneck**
- YOLOv8n on CPU (default) — "slow config with optimizations"
- YOLO can do 50+ FPS on GPU; ONNX Runtime faster than PyTorch
- **Fix:** GPU / ONNX / smaller imgsz (480 or 320)

**4. Image Quality Checks (Per-Frame)**
- 4 checks per frame (blur, darkness, overexposure, uniformity) on every frame
- **Fix:** Cheaper heuristics or cache across consecutive frames

**5. Metrics Decomposition**
- Current: RTT end-to-end (can't separate network vs. server vs. capture)
- **Fix:** Track separately:
  - Network RTT: client send → server receive → send back
  - Server latency: `start_timer` / `end_timer` at server
  - Capture→Alert e2e: frame ready → TTS/haptic fired

### Priority (ROI Order)
1. **Backpressure (send-on-response)** — restores honest latency, enables real FPS measurement
2. **DB offload (buffer + async)** — frees 50–200ms per frame
3. **Model optimization** — GPU/ONNX/imgsz; unlocks FPS ceiling
4. **Metrics split** — decompose delays for visibility
5. **Image QC cache** — reduce steady-state overhead

---

## 📊 Current Specs
- **FPS:** 4 (fixed 250ms interval) → will adapt via send-on-response
- **Latency:** Unknown (queuing distortion); measure after backpressure fix
- **Client capture:** 640×640 JPEG, 70% quality
- **Server:** YOLOv8n (custom or pretrained), CPU-bound
- **Model input:** 640×640 letterboxed
- **Inference:** ByteTrack motion + danger logic per frame

---

## 🛠️ Tech Notes
- **Mute persistence:** localStorage + DB, survives refresh + shared across devices
- **Voice selection:** Async TTS voice list; best-effort gender match
- **Vibration:** Android/HTTPS only; iOS Safari/Chrome = no-op
- **Alert channels:** `audio` mutes vibration, `haptic` mutes audio+mute, `both` enables both
- **Build:** Client Vite (exit 0), Server Python 3.12 (compiles cleanly)
- **Branch:** main (up-to-date, all pushes landed)
