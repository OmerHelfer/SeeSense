"""
WebSocket Streaming Test — SeeSense
Connects to the WebSocket, sends a JPEG image, prints the detection result.

Usage:
    1. Start the server: python main.py
    2. Get a JWT token (login via Postman)
    3. Place a test image (any JPEG) in this folder as test_image.jpg
    4. Paste your token below and run: python test_ws.py
"""

import asyncio
import websockets
import json

# ── Paste your JWT token here ──
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiNjhjZGI4NjUiLCJlbWFpbCI6Im9tZXJoZWxmZXJAZ21haWwuY29tIiwiZXhwIjoxNzc0NjA3ODc1LCJpYXQiOjE3NzQ1MjE0NzV9.lhkyXJ0OeEgFLSHE8mhKOv2MaKS6BCvmgku6iLEZ2Sg"

# ── Server address ──
SERVER = "ws://localhost:8000/stream/ws"

# ── Test image path ──
IMAGE_PATH = "tests/test_images/File2.jpg"


async def test():
    uri = f"{SERVER}?token={TOKEN}"

    print(f"Connecting to {SERVER}...")
    async with websockets.connect(uri) as ws:

        # 1. Receive connection confirmation
        response = json.loads(await ws.recv())
        print(f"Connected! Session: {response['session_id']}\n")

        # 2. Read and send image
        with open(IMAGE_PATH, "rb") as f:
            image_bytes = f.read()

        print(f"Sending image ({len(image_bytes):,} bytes)...")
        await ws.send(image_bytes)

        # 3. Receive detection result
        result = json.loads(await ws.recv())
        print("RAW:", result) 
        print(f"\n{'='*50}")
        print(f"Status:    {result.get('status')}")
        print(f"Danger:    {result.get('danger')}")
        print(f"Alert:     {result.get('alert_level')}")
        print(f"Distance:  {result.get('distance')}")
        print(f"Latency:   {result.get('latency_ms')}ms")
        print(f"Objects:   {len(result.get('objects', []))}")
        print(f"{'='*50}")

        for obj in result.get("objects", []):
            print(f"  - {obj['class_name']} ({obj['confidence']:.1%}) "
                  f"| {obj['distance']} | {obj['position']} | alert: {obj['alert_level']}")

        print(f"\nDone. Disconnecting...")


if __name__ == "__main__":
    asyncio.run(test())