#!/usr/bin/env python3
"""متابعة حالة مهمة توليد عبر get_task حتى الاكتمال أو الفشل."""
import json
import sys
import time
import urllib.request

BASE = "https://work-flow-1-suxx.vercel.app/mcp"


def get_task(task_id: str) -> dict:
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 99, "method": "tools/call",
        "params": {"name": "get_task", "arguments": {"task_id": task_id}},
    }).encode()
    req = urllib.request.Request(
        BASE, data=payload, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode()
    for line in raw.splitlines():
        if line.startswith("data:"):
            d = json.loads(line[5:].strip())
            for c in d.get("result", {}).get("content", []):
                if c.get("type") == "text":
                    return {"text": c["text"]}
    return {"text": raw[:300]}


def main() -> None:
    task_id = sys.argv[1]
    max_seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    start = time.time()
    last_text = ""
    while time.time() - start < max_seconds:
        out = get_task(task_id)
        text = out["text"]
        if text != last_text:  # اطبع فقط عند تغير الحالة
            print(f"[{int(time.time()-start)}s] {text[:400]}", flush=True)
            last_text = text
        low = text.lower()
        if "completed" in low or "مكتمل" in text or "https://" in text:
            print("FINAL:", text[:1500], flush=True)
            return
        if "failed" in low or "فشلت" in text:
            print("FAILED:", text[:800], flush=True)
            return
        time.sleep(15)
    print("TIMEOUT — آخر حالة:", last_text[:400], flush=True)


if __name__ == "__main__":
    main()
