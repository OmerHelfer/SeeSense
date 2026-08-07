# SeeSense — Client Documentation

Complete reference for everything built on the frontend side of SeeSense.

---

## 1. What the client is

A **mobile-first, right-to-left, Hebrew-language web app** that turns a phone into a navigation
aid for blind and visually-impaired pedestrians. It:

- Opens the **rear camera**, captures a square JPEG frame several times a second, and streams the
  frames to the server over a **WebSocket**.
- Draws **live bounding boxes** over the camera feed and renders a neon HUD (corner brackets,
  scan sweep, status badge, spirit level).
- Speaks alerts in **Hebrew** through the Web Speech API and fires **haptic** vibration patterns,
  respecting per-user channel/intensity/voice preferences.
- Uses the phone's **gyroscope** to check the camera is held upright, and refuses to send frames
  while it isn't.
- Runs a **connection health watchdog** that warns (and eventually stops scanning) when latency
  degrades.
- Has a one-tap **SOS button** that sends GPS coordinates to verified emergency contacts.
- Ships a full account area: profile, settings, detection history, feedback flows, SOS history —
  plus **three admin pages** (system performance, user management, feedback triage).

It is a plain Vite SPA (not a bundled native app), designed to be opened in a phone browser.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Framework | React **19** |
| Build tool | Vite **8** |
| Routing | react-router-dom **7** (`BrowserRouter`) |
| Animation | framer-motion **12** (`AnimatePresence`, `motion.*`, `layout`) |
| Icons | lucide-react |
| HTTP | axios (single pre-configured instance) |
| Real-time | native `WebSocket` (binary send, JSON receive) |
| Camera | `navigator.mediaDevices.getUserMedia` + `<canvas>` |
| Overlay | inline `<svg>` |
| Speech | Web Speech API (`SpeechSynthesisUtterance`) |
| Haptics | Vibration API (`navigator.vibrate`) |
| Sensors | `DeviceOrientationEvent`, `navigator.geolocation` |
| Zoom | `PointerEvent` pinch + `MediaStreamTrack.applyConstraints({zoom})` |
| Styling | one hand-written `global.css` design system (~3600 lines), no CSS framework |
| Fonts | Montserrat (display) + Inter (body), from Google Fonts |
| Linting | ESLint 9 flat config + react-hooks + react-refresh |
| State | React state + Context; two module-level singleton stores (no Redux/Zustand) |

---

## 3. Directory layout

```
Client/
├── index.html                  # lang="he" dir="rtl", viewport-fit=cover, font preconnect
├── vite.config.js              # react plugin + an ngrok host allowlist entry
├── eslint.config.js
├── package.json
├── .env / .env.production      # VITE_API_URL, VITE_WS_URL
│
└── src/
    ├── main.jsx                # createRoot + StrictMode
    ├── App.jsx                 # router, ProtectedRoute, AnimatePresence, global SoundToggle
    │
    ├── api/
    │   └── client.js           # axios instance + JWT & 401 interceptors
    │
    ├── config/
    │   └── streamConfig.js     # ⭐ the streaming performance knobs
    │
    ├── context/
    │   └── AuthContext.jsx     # session, localStorage persistence, presence heartbeat
    │
    ├── hooks/
    │   └── useOrientation.js   # gyroscope + iOS permission handling
    │
    ├── components/
    │   ├── CameraView.jsx      # ⭐ camera, capture loop, pinch zoom, bbox overlay
    │   └── SoundToggle.jsx     # floating global mute button
    │
    ├── services/
    │   ├── visionService.js    # ⭐ VisionStream — WebSocket + backpressure + RTT
    │   ├── feedbackService.js  # ⭐ haptics + Hebrew TTS + the settings runtime store
    │   ├── healthService.js    # connection watchdog
    │   ├── clientMetrics.js    # client-side stage timings
    │   ├── authService.js      # login / register
    │   ├── userService.js      # profile, history, feedback, contacts, SOS, passwords
    │   ├── settingsService.js  # detection settings
    │   ├── adminService.js     # admin user + feedback management
    │   └── sessionExpiry.js    # bridge from the axios interceptor into React
    │
    ├── pages/                  # 15 route components (see §12)
    │
    ├── utils/
    │   └── serverDate.js       # timezone-correct parsing/formatting of server timestamps
    │
    └── styles/
        └── global.css          # the whole design system
```

---

## 4. Environment and configuration

`.env` / `.env.production` / `.env.gcp` define `VITE_API_URL` (`.env` also carries `VITE_WS_URL`,
which is unused — the WebSocket URL is *derived* from `VITE_API_URL`). Reading env vars only
through `import.meta.env` keeps the same code working locally, over an ngrok tunnel, and on the
deployed server.

Both `.env.production` and `.env.gcp` set `VITE_API_URL=` (**empty on purpose**): the deployed
server serves this bundle from its own origin, so no host is baked in and the same build works
over any IP or hostname. `.env.gcp` is what `deploy/update.sh` uses
(`npm run build -- --mode gcp`); `.env.production` matches it so a plain `npm run build` can't
produce a bundle pointing somewhere wrong.

`vite.config.js` adds an ngrok hostname to `server.allowedHosts` — needed because a phone can't
reach a laptop's `localhost`, and camera + gyroscope APIs require a **secure context (HTTPS)**,
so real-device testing was done through an HTTPS tunnel.

---

## 5. Routing and app shell (`App.jsx`)

`AuthProvider` → `BrowserRouter` → `AnimatedRoutes` → global `SoundToggle`.

`ProtectedRoute` reads `isAuthenticated` from context and redirects to `/login` otherwise.
`AnimatePresence mode="wait"` keyed on `location.pathname` gives every navigation a transition.

| Route | Page | Access |
|---|---|---|
| `/login` | Login | public |
| `/register` | Register | public |
| `/forgot-password` | ForgotPassword | public |
| `/reset-password` | ResetPassword | public |
| `/` | **Dashboard** (camera) | protected |
| `/settings` | Settings | protected |
| `/profile` | Profile | protected |
| `/contacts` | EmergencyContacts | protected |
| `/history` | History | protected |
| `/sos-history` | SOSHistory | protected |
| `/feedback/general` | GeneralFeedback | protected |
| `/feedback/pending` | PendingFeedback | protected |
| `/feedback/sent` | SentFeedback | protected |
| `/admin/status` | AdminStatus | protected + admin (server-enforced) |
| `/admin/users` | AdminUsers | protected + admin (server-enforced) |
| `/admin/feedback` | AdminFeedback | protected + admin (server-enforced) |
| `/admin/stream-config` | AdminStreamConfig | protected + admin L1 read / L2 write (server-enforced) |

Admin routes are behind `ProtectedRoute` only — the links are hidden unless `user.is_admin`, and
the **server** enforces the actual permission (a non-admin hitting the URL gets a 403 which the
page renders as "אין הרשאת אדמין").

---

## 6. Authentication (`context/AuthContext.jsx`)

- Two localStorage keys: `token` (must match what the axios interceptor reads) and
  `seesense_user`. The session is **rehydrated on mount**, so a page refresh doesn't log you out.
- `login(userData, token)` normalises the backend's `user_id` into `id` so every consumer can use
  `user.id`.
- `logout()` disconnects the active vision stream **first**, then calls `POST /users/logout` to
  blacklist the token server-side, then clears storage and state.
- **Session-expiry handling** — on mount, AuthContext registers a handler with
  `sessionExpiry`. When the axios interceptor sees a 401 on an authenticated call, that handler
  disconnects the stream and clears storage locally. It deliberately does **not** call `/logout`,
  because the token the server just rejected can't authorise that request. `ProtectedRoute` then
  redirects on its own once `isAuthenticated` flips false.
- **Presence heartbeat** — while logged in, `POST /users/heartbeat` fires immediately and then
  every 30 s, so the user reads as "online" in admin views even when not scanning. Cleanly
  cancelled on unmount / logout.

### `services/sessionExpiry.js`
A tiny pub/sub bridge, because the axios interceptor is plain JS and cannot call a React hook.

- `setSessionExpiredHandler(fn)` → returns an unsubscribe function.
- `notifySessionExpired()` — guarded by an `alreadyFiring` flag, because a dead token 401s
  *every* in-flight request at once and a burst of 401s must not trigger a burst of logouts. The
  flag re-arms after 1 s so late 401s from the same dead session are also swallowed.
- Writes a `sessionStorage` notice so `/login` can explain *why* you're back there
  ("החיבור פג תוקף. יש להתחבר מחדש.") instead of showing a blank form you didn't ask for.

### `api/client.js`
```js
axios.create({ baseURL: import.meta.env.VITE_API_URL, timeout: 8000 })
```
- **Request interceptor** attaches `Authorization: Bearer <token>` when a token exists.
- **Response interceptor** calls `notifySessionExpired()` on a 401 — but **only** for
  authenticated calls. `PUBLIC_AUTH_PATHS` (`/users/login`, `/users/register`,
  `/users/forgot-password`, `/users/reset-password`) are excluded, because a 401 there means
  "wrong credentials", not "your session died"; logging someone out for mistyping a password
  would be absurd.

---

## 7. Streaming configuration (`config/streamConfig.js`) ⭐

**As of 2026-08, these three numbers are no longer build-time constants.** They are owned by the
SERVER (`Server/services/stream_config_service.py`), stored in Mongo (`app_config` collection,
doc `_id: "stream"`), editable from a level-2 admin page at `/admin/stream-config`, and delivered
to every client in the WebSocket `connected` message. This exists because retuning used to mean
an edit + rebuild + redeploy, and a phone holding a cached bundle would silently keep the old
values with no way to tell from outside.

`streamConfig.js` now holds only the **pre-connect fallback** and a runtime cache:

```js
export const getInputSize          = () => _current.inputSize;
export const getMaxInflight        = () => _current.maxInflight;
export const getCompressionPercent = () => _current.compressionPercent;
export const getJpegQuality        = () => 1 - _current.compressionPercent / 100;
export function applyStreamConfig({ input_size, compression_percent, max_inflight }) { ... }
```

Consumers **must** call the getters at use time (`getJpegQuality()` inside `toBlob`, `getMaxInflight()`
inside `canSend`), never destructure a snapshot at module load — the value can change on every
reconnect. `applyStreamConfig()` is called from `VisionStream`'s `connected` handler, before
`onConnected` fires, so the very first captured frame already uses the new values.

### The three knobs

| Field | Default | Range | Effect |
|---|---|---|---|
| `input_size` | 640 | 160–640 (step 32) | Square capture/detection size. Smaller = faster inference + smaller uploads, but the model sees less detail (may miss small/distant objects). |
| `compression_percent` | 75 | 0–95 (step 5) | JPEG compression. Higher = fewer bytes on the wire and higher FPS on a weak link, but past ~85% YOLO's confidence on real detections tends to drop below the `medium` profile's threshold. |
| `max_inflight` | 6 | 1–16 | Pipeline depth — see below. |

`MAX_INFLIGHT` (pipeline depth): how many frames may be sent-but-unanswered at once. Little's Law:

```
FPS     ≈ depth ÷ time_per_frame     (time_per_frame = network there + server + network back)
latency ≈ depth × time_per_frame
```

Raising depth adds FPS only while the bottleneck stage (server GPU or network) still has spare
capacity (< ~85% utilisation, shown on `/admin/status`). Past that, extra depth adds pure latency
with no FPS gain — the bottleneck is already saturated. It is a **bounded** queue, not
fire-and-forget, so a slow server can never build an unbounded backlog.
`MAX_INFLIGHT` is the **only** control on the client's send rate — there is no server-side FPS
setting.

### Admin page (`pages/AdminStreamConfig.jsx`, level 2 only)

Route `/admin/stream-config`, linked from Settings → ניהול (hidden for level < 2). Shows each
field's live server value, code default, and an editable draft; Save (`PUT /admin/stream-config`)
is disabled until a value actually differs from the server's, and a value the admin types out of
range is silently clamped server-side and the draft snaps back to what was actually stored. Reset
(`DELETE /admin/stream-config`) drops the Mongo override and returns to code defaults. Level 1
admins can view the same page read-only (`GET /admin/stream-config`, gated by `verify_admin`); the
write endpoints require `verify_super_admin`.

**Changes are never applied mid-scan** — only at the next WebSocket connect, because resizing
`input_size` under a live session would invalidate every tracker's box history (built in the old
coordinate space).

---

## 8. `VisionStream` — the WebSocket client (`services/visionService.js`) ⭐

A class wrapping one streaming session, constructed with `{ onResult, onError, onConnected }`.

### URL derivation
`VITE_API_URL` is transformed: `https://` → `wss://`, `http://` → `ws://`, then
`/stream/ws?token=<jwt>&input_size=<getInputSize()>`. That query param is only a fallback hint —
the server's global config (§7) overrides it and echoes the authoritative value back in
`connected`. `socket.binaryType = 'blob'` (only binary goes up; responses are text JSON).

### Config handshake
The `connected` message carries `input_size`, `compression_percent` and `max_inflight`.
`VisionStream` calls `applyStreamConfig(msg)` on receipt, before its own `onConnected` callback
fires, so capture/encode/backpressure are all on the new values before the first frame is drawn.

### Bounded-depth backpressure
`_sendTimes` is a FIFO of `performance.now()` timestamps for sent-but-unanswered frames.

```js
get canSend() {
  // prune entries older than MAX_INFLIGHT_MS (3000) — a lost result must not wedge the pipe
  return this._sendTimes.length < Math.max(1, getMaxInflight());
}
```

Depth 1 caps throughput at `1/RTT` even when the server is idle; a small depth keeps the network
pipe full so throughput approaches `depth/RTT` while each frame's latency stays about one RTT.
The 3-second stale-entry prune means a dropped result can't permanently block sending. The FIFO
is also capped at `MAX_PENDING_RTT = 120` entries.

### RTT measurement
Results arrive in send order, so `_recordRtt()` pops the oldest send timestamp and pairs it with
the incoming result. Both `result` **and** `error` messages record an RTT — an error still means
that frame is done, and its FIFO entry must be cleared. A rolling 50-sample buffer feeds
`{avg, min, max}` stats exposed via `rttStats`.

### Periodic reporting (every 5 s)
Three small text messages, none of them on the frame hot path:
- `rtt_report` — average RTT
- `fps_report` — actual capture FPS, from the last 30 send timestamps
- `client_stage_report` — the aggregated client stage breakdown from `clientMetrics`

All three are wrapped in `try/catch` in case the socket closed mid-send.

### Reconnection policy
- Close code **1000** (clean/intentional) → no reconnect.
- Close code **4001** (missing token) or **4003** (invalid/expired token) → **do not reconnect**;
  reconnecting would just replay the same dead token forever. Instead, fire
  `notifySessionExpired()` so the app logs out and redirects to `/login`.
- Any other unexpected close → retry after `RECONNECT_DELAY_MS = 3000`, up to
  `MAX_RECONNECT_ATTEMPTS = 5`, then give up and report an error.

### Module-level active-stream reference
`setActiveStream()` / `disconnectStream()` / `getActiveStreamRtt()` let AuthContext tear the
socket down on logout or session expiry without holding a React ref.

---

## 9. Camera and capture (`components/CameraView.jsx`) ⭐

### Props
`isActive`, `onFrameCapture(blob)`, `shouldCapture()`, `inputSize`, `detections`.

### Lifecycle
`getUserMedia({ video: { facingMode: 'environment', width: {ideal:1280}, height: {ideal:720} }, audio: false })`.
On denial: a Hebrew alert explaining camera access is mandatory. Tracks are stopped and `srcObject`
cleared on teardown, and zoom resets when deactivated.

### Pinch-to-zoom
Tracked via `PointerEvent`s in a `Map` keyed by `pointerId`, with `setPointerCapture` so events
keep arriving if a finger leaves the element. Zoom range 1–5×. It tries **native hardware zoom
first** (`track.applyConstraints({ advanced: [{ zoom }] })`, clamped to the device's reported
capability range) for better image quality, and always applies a CSS `scale()` as the visual
fallback. `touchAction: 'none'` stops the browser's own scroll/zoom from interfering.

### The capture pipeline
1. **Cheap early-out first.** `shouldCapture()` is checked *before* touching the canvas, so a
   frame the consumer would drop (not scanning, not aligned, or backpressure says wait) costs
   essentially nothing — no draw, no encode.
2. Keep the offscreen canvas square at the current `inputSize`.
3. **Zoom-aware crop**: a higher zoom samples a smaller central region of the raw video, so the
   captured frame matches what the user actually sees.
4. `ctx.drawImage(...)` → timed as the **`capture`** stage.
5. `canvas.toBlob(cb, 'image/jpeg', getJpegQuality())` → timed as the **`encode`** stage. `toBlob` is
   used rather than `toDataURL` because it is async (doesn't block the main thread) and hands back
   a Blob that goes straight onto the WebSocket with no base64 → bytes copy.

### Polling for a send opportunity
```js
const CAPTURE_POLL_HZ = 120;
setInterval(captureFrame, 1000 / CAPTURE_POLL_HZ);
```
This timer does **not** set the frame rate — the server's `max_inflight` does. It only asks, often, whether a
frame may be sent. An in-flight slot frees the instant a *result* arrives, which never aligns with
a fixed timer; polling slowly means a freed slot idles until the next tick, and that dead time is
lost throughput. At 120 Hz the wait is at most ~8ms, and ticks that can't send are near-free
because of the early-out above.

It is technically an upper bound (you can't send more often than you look), but 120 sits far above
what any server here can process, so pipeline depth always binds first.

### Detection overlay geometry
The hardest bit of maths in the client: mapping a bbox in `inputSize × inputSize` space onto
on-screen pixels.

The captured frame is the **centre square** (side = `min(videoW, videoH)`) of the raw video. The
`<video>` uses `object-fit: cover`, so it's scaled by `coverScale = max(cW/vW, cH/vH)` and
centred. That centre square therefore becomes a centred square of side
`squareSide = baseSize × coverScale` in container coordinates, at offset
`((cW - squareSide)/2, (cH - squareSide)/2)`. Scaling factor from detection space to container
pixels is `squareSide / inputSize`.

Zoom is applied as an **identical CSS `scale()` on both the video and the SVG**, so mapping is
done in *pre-zoom* space and the boxes track the feed at any zoom level. Stroke widths, font
sizes and padding are divided by `zoom` so they stay screen-constant.

Boxes are keyed by `track_id` when available (stable identity across frames → smooth animation
instead of remount flicker). Colours mirror the alert palette: `high` `#ff3b30`, `low` `#eab308`,
`none` `#00f0ff`. Labels flip above/below the box so they never fall off-screen, and use
`paintOrder="stroke"` with a dark outline for legibility over any background.

### Ref mirroring
`inputSize` and `shouldCapture` are mirrored into refs, because putting them in `captureFrame`'s
dependency array would recreate the callback and **restart the capture interval** on every change.

---

## 10. Orientation (`hooks/useOrientation.js`)

Reads `DeviceOrientationEvent`. "Aligned" means the phone is held upright:
`|beta - 90| ≤ 15°`.

Platform split, which is the whole reason this is a hook:
- **Android / desktop** — the listener attaches immediately on mount; permission state is
  `granted`.
- **iOS 13+** — `DeviceOrientationEvent.requestPermission()` **must** be called from a user
  gesture. So the hook exposes `requestPermission()`, and `Dashboard.toggleScan()` awaits it
  inside the "start scanning" button handler. Idempotent, and handles dismissal/denial.

Returns `{ beta, gamma, isAligned, permissionState, requestPermission }`.

---

## 11. Dashboard — the camera page (`pages/Dashboard.jsx`)

The main screen. State: `isScanning`, `alertLevel`, `healthStatus`, `healthRtt`, `detectionDir`,
`detectedClass`, `detections`, `quickReportState`, `feedbackState`, `sosState`,
`showLogoutConfirm`, plus `inputSize` (driven by the server's `connected` message).

### Start / stop scanning (`toggleScan`)
Starting: `await requestPermission()` (iOS gyro) → construct `VisionStream` with the result
handler → `connect(token)` → register as the active stream → `startHealthWatch(...)`.
Stopping: disconnect, reset all HUD state, `stopHealthWatch()`.
Either way: a haptic pulse (`start`/`stop`) and a spoken confirmation
("סריקה הופעלה" / "סריקה הופסקה").

### Result handling (`handleResult`)
Runs per frame, and is a `useCallback` with a stable reference (live values read through refs) so
it never causes a re-subscribe:
1. Ignore if not scanning, or if `status === 'paused'`.
2. Store `record_id` (used to link a quick feedback report to the exact frame).
3. Update the overlay (`setDetections`), `alertLevel`, and the leading object's direction and
   Hebrew class name. Timed as the **`render`** stage.
4. If `danger_cleared` → speak "נתיב פנוי" once, clear the direction HUD, return.
5. **Gate voice + haptics on `alert_is_new`.** The server computes this per `track_id`, so the
   same still-present object doesn't re-trigger TTS/vibration on every frame — while the visual
   HUD keeps updating live. This is the single most important detail for the app not being
   unbearable to use.
6. `danger` → `haptic('danger')` + `announceDetections(objects, true)` (→ "סכנה! מכונית מצד ימין");
   `low` → `haptic('detection')` + `announceDetections(objects, false)`. Both briefly show the
   "wrong detection?" button. Timed as the **`feedback`** stage.

### Capture gate (`canCaptureFrame`)
`isScanning && isAligned && stream.isOpen && stream.canSend`. Handed to CameraView and checked
before the encode. `handleFrameCapture` **re-checks the same conditions at send time**, because
alignment or the in-flight count may have changed during the async encode.

### HUD elements
- **Corner brackets** — grey → cyan (scanning) → green (aligned).
- **Status badge** — `IDLE` → `LIVE` (scanning, not aligned) → `TRACKING` (scanning + aligned).
- **Scan sweep line** — only while scanning *and* aligned, i.e. only while frames are actually
  being sent. Honest feedback rather than decoration.
- **`SpiritLevel`** — a gyroscope bubble that moves with `gamma` (left/right) and `beta - 90`
  (front/back), clamped to the container radius, glowing green when aligned. Label
  "⬤ מיושר" / "◯ יישר מצלמה".
- **Tilt warning** — a full overlay "הטה את המכשיר" while scanning but not aligned.
- **Direction indicator** — arrow (← → ↑) + Hebrew class name + direction word, colour-coded by
  alert level.
- **Alert overlay** — a pill "⚠ סכנה קרובה" / "! שים לב" with `role="alert"` and
  `aria-live="assertive"`; the viewport gets a pulsing red border on high danger.
- **`HealthDot`** — colour-coded dot + Hebrew label. The **millisecond number is shown only to
  admins (level ≥ 1)** — regular users get the dot and label. `dir="ltr"` on the number so RTL
  layout doesn't reorder "87 ms" into "ms 87".
- **Quick report button** (bottom-left, always visible while scanning) — one tap files a
  `wrong_detection` report against the last `record_id`, with haptic + spoken confirmation and a
  2.5 s cooldown.
- **Contextual feedback button** — appears for 3.5 s after any alert.
- **SOS button** — single tap (deliberately *not* long-press): `getCurrentPosition` with a 5 s
  timeout and high accuracy, falling back to `(0, 0)` on failure so the alert still goes out.
  States `idle → sending → sent → idle`, with haptic and spoken confirmation.
- **Logout confirmation modal** and a floating glass **tab bar** (יציאה / בית / הגדרות).

---

## 12. Pages

| Page | What it does |
|---|---|
| **Login** | Email + password, show/hide toggle, mesh-blob animated background, maps the backend's "Invalid email or password" to a Hebrew message, and surfaces the session-expired notice. |
| **Register** | Name, email, phone, ISO country code, optional date of birth, password (min 6). Uppercases the country code before sending. Redirects to `/login` on success. |
| **ForgotPassword** | Sends a reset code; then shows a success state explaining the 15-minute validity and a button that forwards the email to `/reset-password` via router state. |
| **ResetPassword** | Email (pre-filled), 6-digit numeric-only code, new password + confirmation with live mismatch styling. |
| **Dashboard** | See §11. |
| **Settings** | The hub. Categories: **כללי** (profile / SOS history / detection history / a collapsible "scan settings" accordion), **משוב** (general / pending / sent, with an unread-response badge), **ניהול** (admin pages, only when `user.is_admin`). Scan settings contains sensitivity, alert channel, volume + vibration sliders, TTS voice, and the 14-class high-risk chip grid with select-all/clear-all. Has an **unsaved-changes guard** on back (save / discard / keep editing) driven by a `snapshotOf()` JSON comparison with arrays sorted, so class reordering isn't a false diff. Feedback-store fields write *through* the shared store so the floating mute button stays in sync. |
| **Profile** | View/edit personal details (email read-only), unsaved-changes guard, shortcut to contacts, and a "danger zone" self-delete with confirmation. |
| **EmergencyContacts** | Three modes in one page: `list` / `add` / `verify`. Add sends a code to the contact's email; verify takes the 6 digits with resend support; contacts show verified/pending status; cap of 5 enforced in the UI. |
| **History** | Records **grouped by session**, expandable, first session auto-expanded. Summary tiles: today's alerts, total scans, and a **safety score** (`1 - dangerFrames/totalFrames`). Period filter chips. Each frame row shows time, alert badge, Hebrew object names, distance, and a flag/check icon indicating whether feedback already exists. Tapping a row opens a bottom action sheet: report an error (type chips + notes) or delete the record. |
| **SOSHistory** | Expandable cards per alert: timestamp, contact count, GPS coordinates with a "פתח במפות" link, and the full list of notified contacts. Handles the GPS-unavailable `(0,0)` case explicitly. |
| **GeneralFeedback** | Type chips + free-text description, not linked to any detection. |
| **PendingFeedback** | Quick reports awaiting notes. List → form view showing the **detection snapshot** ("what was detected in this frame"), editable type, notes, then submit. |
| **SentFeedback** | Submitted reports with their admin handling status (ממתין / בטיפול / טופל). Shows the **team's response** when resolved, with a "תשובה חדשה" pill for unseen ones and a modal for the full text; calls `markResponsesSeen()` on load to clear the badge. Editing is **locked** once an admin takes the report (shows a lock icon instead of the edit button, mirroring the server's 409). |
| **AdminStatus** | The performance dashboard. Auto-refreshes every 3 s. Eleven range presets (חי / מההתחלה / 30 דק׳ / שעה / יום / שבוע / חודש / 3 ח׳ / 6 ח׳ / שנה / מותאם) plus a custom `datetime-local` picker converted to epoch seconds. Stat cards (uptime or measured span, FPS, frames, throughput), an FPS comparison table (client actual vs server actual/capacity/overall), a latency comparison (**שרת בלבד** / **לקוח בלבד** / **End-to-End** + an estimated network figure), per-stage breakdowns for both server and client, and a **hand-drawn canvas RTT chart** with grid, gradient fill, threshold lines at 100/150/200 ms, and a span label computed from real timestamps. The reset-everything button is gated to level 2. |
| **AdminUsers** | Stat cards (total / online / offline / **admins online**, the last being a clickable modal). Email lookup → a full user card: presence + level badges, data counts (detections / feedback / sessions / contacts / SOS), editable details, full emergency-contact list, password reset, admin-level chips (L2 only), permanent delete (L2 only, not self). The admins modal sorts online-first by level, then offline by most-recently-seen, and clicking an admin opens their full detail. Level-1 admins see an explanatory hint instead of management controls when viewing another admin. |
| **AdminFeedback** | Triage queue. Stat cards double as filters (הכל / ממתין / בטיפול / טופל). Each card shows the submitting user (clickable → a details modal), type, date, detection snapshot, notes, who is handling it, and the resolution note. Actions by permission: **קח לטיפול** (L1+), **סמן כטופל** (handler or L2, requires a response note), **הקצה לאדמין** (L2 only). A level-1 admin looking at someone else's in-progress item sees a lock explaining only level 2 can override. After an action the single item is patched **in place** and stats recomputed locally, so filter and scroll position survive. |
| **AdminStreamConfig** | The global `input_size` / `compression_percent` / `max_inflight` editor (§7). L1 can view, L2 can save/reset. Each field shows the live server value, the code default, and a "changed — not yet saved" flag on the draft; save is disabled until something actually differs from the server. A banner states plainly that these are global and take effect on each client's next scan, not immediately. |

---

## 13. Feedback service — haptics, TTS and the settings store (`services/feedbackService.js`) ⭐

This module does three jobs.

### (a) A runtime settings store
Single source of truth for the four "feedback" preferences (`volume_intensity`,
`vibration_intensity`, `alert_type`, `voice_gender`). The **DB is the durable store**; this
mirrors it into `localStorage` so values are available instantly on load and — crucially — are
actually *applied* when producing sound or vibration. Exposes `getFeedbackSettings()`,
`setFeedbackSettings(patch)`, `seedFeedbackSettings(dbSettings)` and a `subscribeFeedback()`
pub/sub so the Settings sliders and the floating mute button stay in sync with each other.

### (b) Haptics
Named patterns in milliseconds:

| Name | Pattern | Meaning |
|---|---|---|
| `start` | `[60,30,60]` | scanning started |
| `stop` | `[80]` | scanning stopped |
| `aligned` | `[30]` | device just became aligned |
| `detection` | `[100,50,100]` | low-level object detected |
| `danger` | `[200,100,200,100,400]` | high-danger object nearby |

Gated by `alert_type` and `vibration_intensity`. The Vibration API can't change amplitude, only
duration — so intensity **scales the vibrating pulses** (even indices) while leaving the pauses
(odd indices) intact. `isVibrationSupported()` lets Settings warn that iOS Safari/Chrome has no
Vibration API at all.

### (c) Hebrew text-to-speech
- `HEBREW_NAMES` maps all **14** backend class names to Hebrew (מכונית, אופניים, בור בכביש,
  קורקינט…). The backend's `alert_message` is English, so the client always composes its own
  Hebrew utterance.
- **Voice selection** — the TTS voice list loads asynchronously in most browsers, so it's cached
  and refreshed on the `voiceschanged` event. Hebrew voices are filtered by `lang` starting with
  `he`; gender is best-effort matched against name hints (`carmit`/`female`/`אישה` vs
  `asaf`/`male`/`גבר`), falling back to "not the opposite gender", then to the first Hebrew voice.
  `getVoiceInfo()` tells Settings how many Hebrew voices exist so it can warn that gender choice
  may not sound different on this device.
- **Throttling** — a 3-second cooldown, tracked separately for arbitrary messages
  (`speakMessage`) and for object announcements (`announceDetections`, additionally keyed on the
  class name so a *different* object can interrupt).
- `speakMessage(text, { priority })` — `priority: true` bypasses the cooldown, for one-shot edges
  the caller already rate-limits (the danger repeat re-armed the cooldown every 2s and was
  swallowing the "נתיב פנוי" that followed it).
- **`speakStatus(text)` QUEUES instead of cancelling** — used for connection lifecycle and static
  obstacles. Ordered pairs ("סריקה הופעלה, מתחבר" → "התחבר בהצלחה") were being destroyed twice
  over: the 3s cooldown *dropped* the second (connecting takes ~300ms, inside the window) and
  `_speak`'s `cancel()` would have cut the first off mid-word. The Web Speech API already queues —
  the fix is not to clear it. Alerts still cancel, which is the correct priority.
- `announceDetections(objects, isDanger)` builds e.g. `"סכנה! מכונית מצד ימין"` from the class
  name plus a direction suffix (`DIRECTION_LABELS`: `מצד שמאל` / `מצד ימין` / `לפניך`).
- `dangerPhrase(objects)` composes the repeating close-danger warning so it names *what* the danger
  is, not just that there is one.
- **`staticPhrase(className, position)`** → `"אדם לפניך, אין תנועה"`. Spoken when the server sends
  `static_notice` — a watched object that is present but motionless. This is the sentence that lets
  "נתיב פנוי" stop being a lie: a person standing still scores no alert level, and the app used to
  read that silence as an all-clear. See `SERVER.md` → `evaluate_presence`.
- `previewVoice()` bypasses the cooldown so choosing a voice in Settings plays a sample
  immediately. `announceMute()` bypasses **both** the cooldown and the audio gate — otherwise
  "שֶׁמַע כָּבוּי" would be inaudible exactly when you need to hear it. Its three words are stored as
  `\u` escapes with **niqqud**: unvowelled שמע has several valid readings and the engine picked the
  wrong one, and the vowel marks are invisible combining characters that a paste would silently
  strip.
- **Mute is derived, not a separate flag**: "muted" ⇔ the audio channel produces no sound.
  `setMuted(true)` sets volume 0 and cancels any in-flight speech; unmuting restores 0.8 and, if
  `alert_type` was `haptic`, switches it to `both` so audio is actually audible.

---

## 14. Health watchdog (`services/healthService.js`)

Polls `GET /health` every 5 s (4 s timeout) and measures RTT.

The **dot** changes at each threshold immediately. The **voice** is deliberately slower — every
spoken line has to earn itself, because this app talks to someone who cannot glance at the screen
to check it.

| Level | Threshold | Voice |
|---|---|---|
| GREEN | < 100 ms | silent — except as a *recovery* (below) |
| YELLOW | ≥ 100 ms | "החיבור לא יציב" — only after `DEGRADED_CONSECUTIVE = 2` pings agree |
| ORANGE | ≥ 150 ms | "החיבור חלש מאוד, מומלץ לעבור למקום עם קליטה טובה יותר" — same 2-ping gate |
| RED | ≥ 200 ms × **3 consecutive** | haptic `danger` + **"החיבור אבד"**, fires `onDisconnect` |

**Recovery names what it came back TO**, since below the red threshold still spans stable, unstable
and very weak: "החיבור חזר, החיבור יציב" / "…החיבור לא יציב" / "…החיבור חלש מאוד". A degraded link
returning to green says "החיבור יציב" — but **only if a problem was actually announced first**,
otherwise every good ping would say it forever.

Three separate rules stop this from crying wolf, which for a blind user is a safety failure rather
than an annoyance:

- **`DEGRADED_CONSECUTIVE = 2`** — one slow ping says nothing at all. Without it, a single blip
  announced "חלש מאוד" and then "יציב" five seconds later, on repeat, roughly every 10 seconds.
- **`RED_CONSECUTIVE = 3` / `RECOVER_CONSECUTIVE = 2`** — streaks, not single readings, so one
  unlucky ping cannot kill an otherwise fine session.
- **announce-once flags**, reset on recovery, so a genuinely new degradation is still announced.

> The RED message says only **"החיבור אבד"**. It previously said "החיבור אבד, הסריקה הופסקה" — but
> the scan does **not** stop: `onDisconnect` only logs, and the WebSocket keeps sending. Telling a
> blind user their scan stopped while it is still running is the worst direction for that error.

A timeout or network error is treated as infinitely slow.

⚠️ The ping interval interacts with the server's `--timeout-keep-alive`; see the warning in
`SERVER.md` §23 before changing either.

---

## 15. Client metrics (`services/clientMetrics.js`)

Mirrors the server's per-stage breakdown for the **on-device** half of the pipeline. Four stages:

| Stage | Measures |
|---|---|
| `capture` | `drawImage` — video frame → offscreen canvas |
| `encode` | `canvas.toBlob` — JPEG compression (wall time until the callback) |
| `render` | applying a returned result: overlay boxes + HUD state |
| `feedback` | dispatching TTS + haptics for a new alert (only when one fires) |

(The network round trip between `encode` and `render` is RTT, measured separately.)

Zero-overhead by design: each record is one array push on a bounded 100-sample rolling buffer,
no timers, nothing allocated on the hot path. `getClientStageReport()` aggregates to avg/min/max
per stage; VisionStream ships it once every ~5 s piggy-backed on the existing RTT report, and it
surfaces on the admin dashboard as "פירוט זמן עיבוד בלקוח".

---

## 16. Service layer

| Module | Responsibility |
|---|---|
| `authService` | `register`, `login` |
| `userService` | Profile (get/update/delete/heartbeat), contacts (get/add/verify/resend/remove), SOS (`emergencyAlert`, `getEmergencyAlerts`), history (get/delete one/clear all), feedback (quick, general, from-history, pending, submitted, submit, update, delete, `getFeedbackRecordIds` → a `Set` for History's badges, unseen count, mark seen), passwords (`forgotPassword`, `resetPassword`) |
| `settingsService` | `getSettings`, `updateSettings`, `getAvailableClasses`, `resetSettings` |
| `adminService` | `getOverview`, `getAdmins`, `getUserByEmail`, `setUserPassword`, `updateUser`, `setUserLevel`, `deleteUserByEmail`, `getFeedbackAdmin`, `takeFeedback`, `resolveFeedback`, `assignFeedback` |
| `visionService` | `VisionStream` + active-stream helpers |
| `feedbackService` | Haptics, TTS, feedback-settings store |
| `healthService` | `startHealthWatch`, `stopHealthWatch`, `getHealthStatus`, `getLastPingRtt` |
| `clientMetrics` | `recordClientStage`, `getClientStageReport`, `resetClientStages` |
| `sessionExpiry` | Interceptor → React bridge |

Two small details worth noting: `submitFeedback()` picks the right endpoint automatically —
`/update` when there are notes or a type change, `/submit` otherwise. And axios `DELETE` with a
JSON body requires the `data` key in the config object, which is why `removeContact` and
`deleteUserByEmail` look slightly unusual.

---

## 17. Timezone handling (`utils/serverDate.js`)

A real bug, fixed properly. The server writes timestamps with `datetime.now().isoformat()`,
which on the UTC-configured server host produces a UTC value **with no timezone marker**
(`"2026-07-25T11:30:00.123456"`). Browsers parse a marker-less ISO string as **local** time, so
every relative time was off by the viewer's UTC offset — a just-now event displayed as "3h ago"
in Israel (UTC+3 in summer).

- `parseServerDate(iso)` — appends `Z` when the string carries no `Z` and no `±HH:MM` offset,
  leaving already-qualified strings untouched.
- `formatServerDateTime(iso)` — formats in `he-IL` **pinned to `Asia/Jerusalem`**, so a timestamp
  reads the same for every viewer regardless of their device timezone.
- `relTime(iso)` — Hebrew relative time: הרגע / לפני N דק׳ / שע׳ / ימים / חודשים / שנים.

Used by AdminUsers, AdminFeedback and SentFeedback.

---

## 18. Design system (`styles/global.css`)

Hand-written, ~3600 lines, no framework. "Premium Dark Futuristic — Dark Glassmorphism · Neon HUD
· Mobile-first".

### Tokens
- **Palette** — `--bg #000`, `--bg-1 #060a0f`, `--bg-2 #0d1117`; accents `--cyan #00F0FF`,
  `--yellow #EAFF00`, `--purple #7B2FFF`; semantic `--danger #FF3B30`, `--caution #FF9F0A`,
  `--safe #00E5A0`; text at 100 % / 65 % / 35 % opacity.
- **Glass surfaces** — `--glass-bg rgba(255,255,255,0.04)`, `--glass-border …0.09`, plus a shine
  layer, used with `backdrop-filter`.
- **Glows** — cyan / danger / safe box-shadow presets for the neon look.
- **Radii** — `--r-xs 8px` through `--r-xl 32px`.
- **Safe areas** — `--sat/--sab/--sal/--sar` from `env(safe-area-inset-*)`, so the HUD and tab bar
  clear the iPhone notch and home indicator (paired with `viewport-fit=cover` in `index.html`).
- **Typography** — Montserrat display, Inter body.

### Global rules
`direction: rtl` on `<body>`, `overflow: hidden` and `height: -webkit-fill-available` (the iOS
Safari 100vh workaround), `user-select: none` and `-webkit-tap-highlight-color: transparent` for
an app-like feel, and a visible `:focus-visible` cyan outline for keyboard accessibility.

### Notable components
Mesh-blob animated auth backgrounds; the whole HUD (corner brackets with pulse keyframes, scan
sweep, spirit level, live badge with blinking dot, alert overlay with `danger-pulse-border`, tilt
warning with a rocking animation); glass sections, segmented controls, neon-fill range sliders,
class chips, nav rows with badges; admin stat cards, latency rows, range chips, modal cards; the
floating tab bar and sound toggle.

---

## 19. Build and deploy

```
npm install
npm run dev      # Vite dev server (HMR)
npm run build    # production bundle → dist/
npm run preview  # serve the built bundle
npm run lint     # ESLint
```

The built bundle is served by the FastAPI server itself (single origin, single port). Both
production env files leave `VITE_API_URL` empty so the client uses its own origin; the WebSocket
URL is derived from it, so `https` automatically becomes `wss`. See §4.

**Device testing needs HTTPS** — `getUserMedia`, `DeviceOrientationEvent` and `geolocation` all
require a secure context, so local phone testing went through an ngrok tunnel (hence the
`allowedHosts` entry in `vite.config.js`).

---

## 20. Accessibility notes

The primary user cannot see the screen, so non-visual feedback *is* the interface:

- Every alert has an audio and/or haptic channel; the visual HUD is secondary (useful for a
  sighted companion, and for development).
- `aria-label` on every icon-only button, `aria-pressed` on toggles, `aria-current` on the active
  tab, `role="alert"` + `aria-live="assertive"` on the danger overlay, `aria-live="polite"` on the
  tilt warning, `aria-hidden` on decorative HUD layers so a screen reader doesn't read them.
- Spoken confirmation for every state change: scan on/off, mute on/off, feedback sent, SOS sent
  or failed, connection degraded/lost/restored, "נתיב פנוי" when danger clears.
- Alert dedup exists precisely so the audio channel stays usable — an alert every frame would be
  worse than no alert.
- Large tap targets, and the SOS button is a single tap (no long-press, no gesture to learn).

---

## 21. Known issues and cleanup opportunities

Observations from reading the current code:

- **`EmergencyContacts.jsx` line 212 uses `=` instead of `===`:**
  `{c.status='verified' ? (...) : (...)}`. The assignment always evaluates truthy, so **every**
  contact renders as "מאומת" and the local object is mutated — pending contacts lose their
  "אמת עכשיו" button. This is a genuine bug and the highest-value one-character fix in the
  client.
- ~~Hebrew class-name maps are out of sync~~ **Fixed 2026-08-07 (§10w).** `History`, `AdminFeedback`,
  `PendingFeedback` and `SentFeedback` had their own hand-copied `HEBREW_NAMES` (stale — still
  listing `bus`/`truck`, which were never real classes). All four now import the single
  `feedbackService.HEBREW_NAMES`. `Settings.CLASS_META` now covers all 17 real classes.
- ~~**Timezone fix not applied everywhere.**~~ **Fixed 2026-08-07.** `History.jsx`,
  `PendingFeedback.jsx` and `SOSHistory.jsx` called `new Date(ts)` directly instead of
  `parseServerDate`, so their times displayed 3 hours early in Israel (summer) — the server host
  is UTC and writes marker-less ISO strings, which browsers parse as *local*. All three now go
  through `serverDate.js`, and every page that renders a server timestamp uses those helpers.
- ~~**`healthService` thresholds contradict its own documentation.**~~ **Fixed 2026-08-06** — the
  header and every inline comment now name the constants (`THRESHOLD_RED` etc.) rather than
  restating numbers that drift. **The underlying observation still stands, though:** 100/150/200 ms
  is aggressive for a mobile network, so YELLOW fires often outdoors. `DEGRADED_CONSECUTIVE = 2`
  now stops that from being *spoken* on a single blip, but the thresholds themselves were tuned on
  WiFi and are still worth revisiting for cellular.
- **`settingsService` sends a `user_id` query parameter** that the server ignores — it derives the
  user from the JWT. Harmless, but misleading (the file's header comment claims it's required).
- **Stale comment** in `userService.emergencyAlert`: "No auth required (intentionally open)". The
  endpoint *does* require a JWT.
- **`VITE_WS_URL` is defined in both `.env` files but never read** — the WS URL is derived from
  `VITE_API_URL`.
- **Heavy inline styles.** History, PendingFeedback, SentFeedback and GeneralFeedback style large
  chunks inline rather than via `global.css` classes, and repeat the same chip/tile styles. Worth
  consolidating.
- **`Client/README.md` is still the default Vite template text.**
- **No tests** and no error boundary — an exception in a page unmounts the tree with a blank
  screen.
- **`public/` is empty** but `index.html` references `/vite.svg` as the favicon (404).
