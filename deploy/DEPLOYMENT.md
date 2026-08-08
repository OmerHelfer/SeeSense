# SeeSense — Deployment & Session State

Last updated: 2026-08-07. Context: final-year CS project, submission Sunday
2026-08-09. The deployment target is a GPU-backed VM in/near Israel, chosen to
measure real GPU vs. CPU inference latency for the thesis.

There is **one** live deployment — the GCP VM below. It is the single source of
truth: the app it serves is the app that gets submitted.

## Live deployment

### GCP Compute Engine VM (GPU-backed, single service)
- **Region: `europe-central2-c` (Warsaw), NOT Tel Aviv.** `me-west1` (Tel Aviv)
  was the goal but had zero T4 GPU capacity all day, in every zone, on both
  GCP and (untested but likely similarly constrained) AWS `il-central-1`.
  Warsaw was the closest region to Israel that actually had capacity.
  **If `me-west1` frees up later, migrate** (see "Migrating to Tel Aviv"
  below) — Warsaw adds real network latency (~90-100ms measured) that a true
  Tel Aviv deployment would not have.
- Instance name: `seesense`. Machine type: **`n1-standard-1`** (1 vCPU,
  3.75GB) — smaller than ideal (`n1-standard-4` was the target) because the
  zone's capacity only had room for the smaller size alongside the T4. Do
  **not** try to resize this — stopping it to resize risks losing the GPU
  allocation entirely (T4 has been scarce all day everywhere).
- GPU: 1× NVIDIA T4 (16GB VRAM). Model uses a tiny fraction of it — this is
  far more GPU than the workload needs, chosen because it was what was
  actually available, not for performance reasons.
- External IP: `34.116.162.196` → domain `34-116-162-196.nip.io` (nip.io
  auto-resolves the dashed-IP hostname back to that IP — free real HTTPS via
  Let's Encrypt, no domain purchase needed).
- **IP may not be static yet** — check `VPC network → IP addresses`; if not
  yet promoted, stopping/starting the VM will assign a new IP and break the
  domain + certificate. Promote it once (`... menu → Promote to static IP`)
  to make stop/start safe permanently.
- Single-service architecture: FastAPI (`Server/main.py`) serves the built
  React app (`Client/dist`) itself — one process, one port (443), one
  certificate. No separate frontend deploy, no CORS, no mixed content.
- Frontend build mode: `Client/.env.gcp` (empty `VITE_API_URL` → same-origin).
  Built via `npm run build -- --mode gcp`.
- Auth to GitHub from the VM: HTTPS + a Personal Access Token (repo is
  private). `git config --global credential.helper store` was set so it only
  asked once.

## Cost / billing

- GCP credit: **$300 USD** (displayed as ₪921 — same amount, just shown in
  shekels; don't be thrown by the currency).
- GPU quota approved: `GPUS_ALL_REGIONS = 1` (global, not per-region) — you
  can only ever have **one** GPU VM running at a time on this account. A
  second GPU VM create attempt while this one is running/stopped-but-not-
  deleted will fail on quota, not availability.
- Rough cost of this exact config (n1-standard-1 + T4, Warsaw) if left running
  continuously: **~$270/month** (~$0.37-0.42/hr). That's under the $300
  credit but with thin margin — never actually test this by leaving it on for
  real.
- **Actual plan: start only while testing, stop immediately after.** That
  usage pattern costs low single-digit dollars total for the whole project
  window. Stopped VM costs are near-zero (a few cents/month for the 50GB
  disk only — no compute/GPU billing while stopped).
- Billing dashard has a real reporting lag (a few hours, sometimes up to 24h)
  — $0.00 showing there does NOT mean nothing is being billed, just that the
  UI hasn't caught up.

## One-command deploy from your own machine (no browser SSH needed)

```bash
bash deploy/remote-update.sh
```

Runs `deploy/update.sh` on the VM over SSH in one shot — pull, conditional
rebuild, restart. Requires the `gcloud` CLI installed and authenticated
locally (one-time setup, instructions are printed by the script if missing).
Works for any teammate who clones this repo, not just this machine — override
`INSTANCE_NAME`/`ZONE` env vars if their VM differs from the defaults
(`seesense` / `europe-central2-c`).

## Operational commands (on the VM, via SSH — browser SSH button on the
instance in GCP Console, or `Compute Engine → VM instances → SSH`)

```bash
# Check the app is running
sudo systemctl status seesense --no-pager -l

# Live logs
sudo journalctl -u seesense -f

# After pulling new code — fast path, NOT the full setup script:
cd ~/SeeSense
bash deploy/update.sh
# Only rebuilds frontend if Client/ changed; only reinstalls Python deps if
# requirements.txt changed. Seconds to ~1 minute for a typical change.

# Full reinstall (rarely needed — only if something fundamental broke):
bash deploy/setup-vm.sh
```

**Stopping/starting the VM** (GCP Console, not SSH):
`Compute Engine → VM instances → select seesense → Stop` (or `Start`).
The systemd service is `enable`d, so on Start the app comes back up
automatically — no manual redeploy needed, **as long as the IP is static**
(see above; if not promoted, the URL breaks on restart and the cert step in
`setup-vm.sh` needs rerunning for the new IP/domain).

## Known issues hit today, and their fixes (so they don't get re-debugged)

1. **`pip install torch` installs the CPU-only build by default** — costs
   ~10x on every frame, silently. Always install with
   `--index-url https://download.pytorch.org/whl/cu121` first, before
   `pip install -r requirements.txt` (which has `torch` unpinned, so it's
   satisfied by whatever's already installed and won't downgrade it).
   This exact bug cost real time locally earlier today too.
2. **Bare `pip`/`python` not on PATH** on this Deep Learning VM image — use
   `python3 -m pip` / `python3` explicitly everywhere.
3. **Ubuntu 24.04 blocks system-wide pip** (PEP 668,
   "externally-managed-environment") — needs `--break-system-packages`.
   Safe here since the VM exists only to run this app.
4. **`opencv-python` needs `libgl1` + `libglib2.0-0`** system packages to
   import (`ImportError: libGL.so.1`) — the same packages `Server/Dockerfile`
   already installs; were missing from the VM setup script until fixed.
5. **GCP "reservation affinity" error** ("Specified reservations [] do not
   exist") — a stuck form field unrelated to real capacity; fixed by
   `--reservation-affinity=none` when creating via `gcloud` CLI (Cloud Shell),
   or hunting for the "Reservations" dropdown in the web UI's advanced
   settings.
6. **`Server/.env` is gitignored** and does not arrive with `git clone` —
   must be recreated by hand on every fresh VM (`SECRET_KEY`, `MONGODB_URI`,
   `EMAIL_ADDRESS`, `EMAIL_PASSWORD`). Keep a copy somewhere safe; it exists
   nowhere in the repo.

## GPU capacity — what was actually tried today, for context

T4 GPU capacity was checked and failed in, in order: `me-west1` (all zones),
`europe-central2` (Warsaw — eventually succeeded), `europe-west8` (Milan),
and others down the closest-to-Israel ranking. L4 and P4 were also considered
as alternate GPU types when T4 kept failing. RTX PRO 6000 was ruled out
(massively overkill for this model — 96GB VRAM vs. the ~135MB actually used
locally on a laptop RTX 3050 — and requires a mandatory 20 vCPU/80GB bundle
at ~$3-5+/hr). AWS `il-central-1` (genuine Tel Aviv datacenter) was scoped as
a fallback with real g4dn.xlarge pricing (~$0.55-0.65/hr) but never actually
tried, since Warsaw came through on GCP first and AWS has no equivalent free
credit.

## Migrating to Tel Aviv later (if `me-west1` capacity frees up)

1. Create a new VM in `me-west1` — same config (N1 series, T4, ideally
   `n1-standard-4` if capacity allows).
2. `git clone`, recreate `Server/.env`, run `bash deploy/setup-vm.sh` — it
   auto-derives the nip.io domain from whatever IP the new VM gets, no manual
   reconfiguration needed.
3. Note the new URL (new IP → new nip.io domain).
4. Stop/delete the Warsaw VM.
5. No code changes needed — the app is already region-agnostic.

## Performance findings so far (Warsaw, n1-standard-1 + T4, after fixes)

- Server-side inference: genuinely GPU-accelerated now (was silently running
  on CPU earlier today due to the torch bug above — ~200ms/frame on CPU vs.
  ~20-30ms on GPU once fixed).
- `decode_quality` / `tracking` / `danger_logic` are all CPU-bound, unaffected
  by the GPU — their speed depends on CPU clock speed, not GPU choice.
- `db_flush` / `db_write` are neither: they are the batch writer's round trip to
  Atlas (Ireland) — `db_flush` whole, `db_write` divided by the records in the
  batch. Both are off the frame's critical path and bounded by network distance
  to the database, so no amount of CPU or GPU changes them.
- RTT average ~130ms; ~90-100ms of that is network distance
  (Warsaw↔Tel Aviv), not compute — this is the cost of not being in
  `me-west1` yet. Note this is the *wire* round trip (`socket.send` → result
  received); the dashboard's separate **E2E Latency** row is the larger,
  user-facing number that also includes capture, encode, render and the
  spoken alert.
- `MAX_INFLIGHT` (in `Client/src/config/streamConfig.js`) trades FPS/
  throughput against per-frame latency — raising it (currently `6`, was `4`
  originally) closed the gap between server capacity FPS and actual client
  FPS, but increases queueing delay. Since the thesis is about *latency*,
  don't chase FPS numbers by raising this further without weighing that
  tradeoff explicitly.
- Admin performance page has a **reset button** for the persisted stats —
  use it before taking "real" measurements, since today's numbers are
  contaminated by repeated restarts/debugging (e.g. a stray ~13s server-side
  max latency outlier, almost certainly a one-time CUDA JIT warmup on a
  fresh process start, not a real ongoing issue — avg was a healthy 28ms).

## Files changed today (all pushed to `main`)

- `Server/main.py` — static frontend serving with SPA fallback routing and a
  path-traversal guard.
- `Client/src/services/visionService.js` — WebSocket URL falls back to the
  page's own origin when no API URL is baked in.
- `Client/.env.gcp` (new) — build mode for the single-service deploy.
- `.gitignore` (new, root) — excludes `certs/` (a local mkcert private key
  was sitting untracked and would have been committed otherwise).
- `deploy/setup-vm.sh`, `deploy/update.sh` (new) — full setup and fast-update
  scripts, with all the fixes from "Known issues" above baked in.
- `Client/src/config/streamConfig.js` — `MAX_INFLIGHT` changed 4→6 (user's
  own experiment, see Performance findings above).

Locally on the Windows laptop: mkcert-based local HTTPS setup for earlier
same-WiFi testing is still present (`certs/` dir, gitignored) but is no
longer the active testing path — GCP is.
