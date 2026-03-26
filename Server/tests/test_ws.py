"""
WebSocket Streaming Test — SeeSense

Interactive test client for the WebSocket streaming endpoint.
Connects to the server, stays open, and lets you send frames + control detection.

Usage:
    1. Start the server: python main.py
    2. Get a JWT token via POST /users/login in Postman
    3. Paste your token below
    4. Place test images in tests/test_images/ and/or videos in tests/test_videos/
    5. Run: python tests/test_ws.py

Commands (while connected):
    Enter / number  — Send next image (or image by number)
    'all'           — Send all images in sequence (for motion testing)
    'video'         — Extract frames from a video and send them (motion testing)
    'pause'         — Pause detection
    'resume'        — Resume detection
    'status'        — Show session info
    'quit'          — Disconnect and exit
"""

import asyncio
import websockets
import json
import os
import time
import requests
import glob
import cv2

# ── Configuration ──
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiNjhjZGI4NjUiLCJlbWFpbCI6Im9tZXJoZWxmZXJAZ21haWwuY29tIiwiZXhwIjoxNzc0NjA3ODc1LCJpYXQiOjE3NzQ1MjE0NzV9.lhkyXJ0OeEgFLSHE8mhKOv2MaKS6BCvmgku6iLEZ2Sg"
SERVER = "ws://localhost:8000/stream/ws"
IMAGES_DIR = "tests/test_images"
VIDEOS_DIR = "tests/test_videos"
DELAY_BETWEEN_FRAMES = 0.5  # seconds, for 'all' and 'video' mode
VIDEO_FRAME_SKIP = 5  # extract every Nth frame from video


def load_image_list():
    """Find all images in the test_images directory."""
    extensions = ("*.jpg", "*.jpeg", "*.png", "*.bmp", "*.webp")
    images = []
    for ext in extensions:
        images.extend(glob.glob(os.path.join(IMAGES_DIR, ext)))
    images.sort()
    return images


def load_video_list():
    """Find all videos in the test_videos directory."""
    extensions = ("*.mp4", "*.avi", "*.mov", "*.mkv")
    videos = []
    for ext in extensions:
        videos.extend(glob.glob(os.path.join(VIDEOS_DIR, ext)))
    videos.sort()
    return videos


def extract_frames_as_jpeg(video_path, skip=VIDEO_FRAME_SKIP, quality=80):
    """Extract frames from video and return as list of JPEG bytes."""
    cap = cv2.VideoCapture(video_path)
    frames = []
    i = 0
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
        if i % skip == 0:
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
            frames.append(buffer.tobytes())
        i += 1
    cap.release()
    return frames


def print_result(result, round_trip_ms=None):
    """Pretty-print a detection result with timing."""
    result_type = result.get("type", "unknown")

    if result_type == "error":
        print(f"  ERROR: {result.get('detail')}")
        return

    if result.get("status") == "paused":
        print(f"  Frame {result.get('frame')} — PAUSED (no processing)")
        return

    danger_icon = "🔴" if result.get("danger") else "🟢"
    cleared = " ✅ PATH CLEAR" if result.get("danger_cleared") else ""
    server_ms = result.get("latency_ms", 0)

    # Timing info
    if round_trip_ms:
        network_ms = round_trip_ms - server_ms
        timing = f"Total: {round_trip_ms:.0f}ms (server: {server_ms}ms, network: {network_ms:.0f}ms)"
    else:
        timing = f"{server_ms}ms"

    print(f"\n  {danger_icon} Frame {result.get('frame')} — {timing}{cleared}")
    print(f"     Alert: {result.get('alert_level')} | Distance: {result.get('distance')}")

    for obj in result.get("objects", []):
        motion = obj.get("motion", {})
        approaching = " ⚠ APPROACHING" if motion.get("approaching") else ""
        speed = f" ({motion.get('speed')})" if motion.get("speed") != "unknown" else ""

        print(f"     - {obj['class_name']} ({obj['confidence']:.0%}) "
              f"| {obj['distance']} | {obj['position']} "
              f"| track #{motion.get('track_id', '?')}{approaching}{speed}")


async def send_and_measure(ws, image_bytes):
    """Send image bytes and measure round-trip time."""
    start = time.time()
    await ws.send(image_bytes)
    result = json.loads(await ws.recv())
    round_trip_ms = (time.time() - start) * 1000
    return result, round_trip_ms


async def test():
    images = load_image_list()
    videos = load_video_list()

    if not images and not videos:
        print(f"No images in {IMAGES_DIR}/ and no videos in {VIDEOS_DIR}/")
        print("Place some files there and try again.")
        return

    if images:
        print(f"Found {len(images)} test images:")
        for i, img in enumerate(images):
            print(f"  [{i}] {os.path.basename(img)}")

    if videos:
        print(f"\nFound {len(videos)} test videos:")
        for i, vid in enumerate(videos):
            print(f"  [{i}] {os.path.basename(vid)}")

    uri = f"{SERVER}?token={TOKEN}"
    print(f"\nConnecting to {SERVER}...")

    async with websockets.connect(uri) as ws:
        # Receive connection confirmation
        response = json.loads(await ws.recv())
        print(f"Connected! Session: {response['session_id']}\n")

        current_index = 0

        while True:
            print(f"\n[{current_index}/{len(images)}] Command (Enter=next, number, 'all', 'video', 'pause', 'resume', 'status', 'quit'):")
            cmd = await asyncio.get_event_loop().run_in_executor(None, input, "> ")
            cmd = cmd.strip().lower()

            if cmd == "quit" or cmd == "q":
                print("Disconnecting...")
                break

            elif cmd == "pause":
                requests.post("http://localhost:8000/inference/pause_detection",
                              headers={"Authorization": f"Bearer {TOKEN}"})
                print("Detection paused")

            elif cmd == "resume":
                requests.post("http://localhost:8000/inference/resume_detection",
                              headers={"Authorization": f"Bearer {TOKEN}"})
                print("Detection resumed")

            elif cmd == "status":
                res = requests.get("http://localhost:8000/stream/session_status",
                                   headers={"Authorization": f"Bearer {TOKEN}"})
                session_info = res.json().get("session")
                if session_info:
                    print(f"  Session: {session_info['session_id']}")
                    print(f"  Frames:  {session_info['frame_count']}")
                    print(f"  Paused:  {session_info['paused']}")
                else:
                    print("  No active session")
                print(f"  Images loaded: {len(images)}")
                print(f"  Videos loaded: {len(videos)}")
                print(f"  Current index: {current_index}")
                continue

            elif cmd == "video":
                if not videos:
                    print(f"  No videos found in {VIDEOS_DIR}/")
                    continue

                # Choose video
                if len(videos) == 1:
                    vid_idx = 0
                else:
                    print("  Choose video number:")
                    for i, vid in enumerate(videos):
                        print(f"    [{i}] {os.path.basename(vid)}")
                    vid_input = await asyncio.get_event_loop().run_in_executor(None, input, "  > ")
                    vid_idx = int(vid_input) if vid_input.isdigit() else 0

                if vid_idx >= len(videos):
                    print(f"  Invalid index. Max is {len(videos) - 1}")
                    continue

                video_path = videos[vid_idx]
                print(f"\n  Extracting frames from {os.path.basename(video_path)} (every {VIDEO_FRAME_SKIP}th frame)...")
                frames = extract_frames_as_jpeg(video_path)
                print(f"  Extracted {len(frames)} frames. Sending...\n")

                for i, frame_bytes in enumerate(frames):
                    print(f"  Frame [{i}/{len(frames)}] ({len(frame_bytes):,} bytes)")
                    result, round_trip = await send_and_measure(ws, frame_bytes)
                    print_result(result, round_trip)
                    if i < len(frames) - 1:
                        await asyncio.sleep(DELAY_BETWEEN_FRAMES)

                print(f"\n  Video done. {len(frames)} frames sent.")
                continue

            elif cmd == "all":
                if not images:
                    print(f"  No images found in {IMAGES_DIR}/")
                    continue

                print(f"\nSending all {len(images)} images with {DELAY_BETWEEN_FRAMES}s delay...\n")
                for i, img_path in enumerate(images):
                    with open(img_path, "rb") as f:
                        image_bytes = f.read()
                    print(f"  Sending [{i}] {os.path.basename(img_path)} ({len(image_bytes):,} bytes)")
                    result, round_trip = await send_and_measure(ws, image_bytes)
                    print_result(result, round_trip)
                    if i < len(images) - 1:
                        await asyncio.sleep(DELAY_BETWEEN_FRAMES)
                print(f"\nAll {len(images)} frames sent.")
                current_index = 0
                continue

            else:
                if not images:
                    print("  No images loaded")
                    continue

                # Send single image — by number or next
                if cmd.isdigit():
                    idx = int(cmd)
                    if idx >= len(images):
                        print(f"  Invalid index. Max is {len(images) - 1}")
                        continue
                    current_index = idx
                elif cmd == "":
                    pass  # use current_index
                else:
                    print("  Unknown command")
                    continue

                if current_index >= len(images):
                    current_index = 0
                    print("  Looped back to first image")

                img_path = images[current_index]
                with open(img_path, "rb") as f:
                    image_bytes = f.read()

                print(f"  Sending [{current_index}] {os.path.basename(img_path)} ({len(image_bytes):,} bytes)")
                result, round_trip = await send_and_measure(ws, image_bytes)
                print_result(result, round_trip)

                current_index += 1

    print("Done.")


if __name__ == "__main__":
    asyncio.run(test())