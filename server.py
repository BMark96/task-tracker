"""Task tracker backend.

A single-file Flask app. All state lives in tasks.json next to this file;
there is no database. Run with:  python server.py
"""

import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone

from flask import Flask, abort, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "tasks.json")
STATIC_DIR = os.path.join(BASE_DIR, "static")

STATUSES = ("todo", "in_progress", "blocked", "done")

app = Flask(__name__, static_folder=None)

_lock = threading.Lock()
_data = {"projects": []}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id():
    return str(uuid.uuid4())


def normalize_url(u):
    """Return a usable absolute URL, or None. 'google.com' -> 'https://google.com'."""
    u = (u or "").strip()
    if not u:
        return None
    if re.match(r"^[a-z][a-z0-9+.\-]*://", u, re.I) or re.match(r"^(mailto|tel):", u, re.I):
        return u
    return "https://" + u


def load():
    """Read tasks.json into memory once at startup, normalising older records."""
    global _data
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            _data = json.load(f)
    else:
        _data = {"projects": []}
    _data.setdefault("projects", [])
    changed = False
    for p in _data["projects"]:
        p.setdefault("tasks", [])
        for t in p["tasks"]:
            t.setdefault("due", None)
            t.setdefault("url", None)
            # a task used to allow several labels; it now holds at most one
            if "labels" in t:
                existing = t.pop("labels")
                t.setdefault("label", existing[0] if existing else None)
                changed = True
            else:
                t.setdefault("label", None)
            # notes used to be a single string; it is now a list of {id, text, created}
            if not isinstance(t.get("notes"), list):
                text = (t.get("notes") or "").strip()
                t["notes"] = (
                    [{"id": new_id(), "text": text, "created": t.get("created", now_iso())}]
                    if text
                    else []
                )
                changed = True
    if changed:
        save()


def save():
    """Write the whole store back atomically (temp file + rename)."""
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_FILE)


def find_project(pid):
    return next((p for p in _data["projects"] if p["id"] == pid), None)


def find_task(tid):
    for p in _data["projects"]:
        for t in p["tasks"]:
            if t["id"] == tid:
                return p, t
    return None, None


def body():
    return request.get_json(force=True, silent=True) or {}


# --- static files ---------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


# --- projects -----------------------------------------------------------

@app.get("/api/projects")
def list_projects():
    with _lock:
        return jsonify([
            {
                "id": p["id"],
                "name": p["name"],
                "created": p.get("created"),
                "taskCount": len(p["tasks"]),
                "openCount": sum(1 for t in p["tasks"] if t["status"] != "done"),
            }
            for p in _data["projects"]
        ])


@app.post("/api/projects")
def create_project():
    name = (body().get("name") or "").strip()
    if not name:
        abort(400, "name required")
    with _lock:
        p = {"id": new_id(), "name": name, "created": now_iso(), "tasks": []}
        _data["projects"].append(p)
        save()
    return jsonify(p), 201


@app.get("/api/projects/<pid>")
def get_project(pid):
    with _lock:
        p = find_project(pid)
        if not p:
            abort(404)
        return jsonify(p)


@app.patch("/api/projects/<pid>")
def update_project(pid):
    data = body()
    with _lock:
        p = find_project(pid)
        if not p:
            abort(404)
        if "name" in data:
            name = (data.get("name") or "").strip()
            if not name:
                abort(400, "name cannot be empty")
            p["name"] = name
            save()
        return jsonify(p)


@app.delete("/api/projects/<pid>")
def delete_project(pid):
    with _lock:
        p = find_project(pid)
        if not p:
            abort(404)
        _data["projects"].remove(p)
        save()
    return "", 204


# --- tasks ------------------------------------------------------------

@app.post("/api/projects/<pid>/tasks")
def create_task(pid):
    data = body()
    title = (data.get("title") or "").strip()
    if not title:
        abort(400, "title required")
    status = data.get("status") or "todo"
    if status not in STATUSES:
        abort(400, "invalid status")
    with _lock:
        p = find_project(pid)
        if not p:
            abort(404)
        t = {
            "id": new_id(),
            "title": title,
            "status": status,
            "due": data.get("due") or None,
            "url": normalize_url(data.get("url")),
            "notes": [],
            "label": (data.get("label") or "").strip() or None,
            "created": now_iso(),
        }
        p["tasks"].append(t)
        save()
    return jsonify(t), 201


@app.patch("/api/tasks/<tid>")
def update_task(tid):
    data = body()
    with _lock:
        _, t = find_task(tid)
        if not t:
            abort(404)
        if "title" in data:
            title = (data.get("title") or "").strip()
            if not title:
                abort(400, "title cannot be empty")
            t["title"] = title
        if "status" in data:
            if data["status"] not in STATUSES:
                abort(400, "invalid status")
            t["status"] = data["status"]
        if "due" in data:
            # ISO datetime-local string ("2026-09-05T14:30") or null
            t["due"] = data.get("due") or None
        if "url" in data:
            t["url"] = normalize_url(data.get("url"))
        if "label" in data:
            t["label"] = (data.get("label") or "").strip() or None
        save()
        return jsonify(t)


@app.delete("/api/tasks/<tid>")
def delete_task(tid):
    with _lock:
        p, t = find_task(tid)
        if not t:
            abort(404)
        p["tasks"].remove(t)
        save()
    return "", 204


@app.post("/api/projects/<pid>/tasks/move")
def move_tasks(pid):
    """Reorder/relocate one or more tasks. Task array order is the display order.

    Body: {ids: [...], status?: "todo"|..., before?: "<task id>" | null}
    Tasks in `ids` are pulled out (keeping the given order), optionally restatused,
    and reinserted immediately before task `before` (or appended if before is
    missing/unknown).
    """
    data = body()
    ids = data.get("ids") or []
    status = data.get("status")
    before = data.get("before")
    if status is not None and status not in STATUSES:
        abort(400, "invalid status")
    with _lock:
        p = find_project(pid)
        if not p:
            abort(404)
        idset = set(ids)
        rank = {tid: i for i, tid in enumerate(ids)}
        moving = sorted(
            (t for t in p["tasks"] if t["id"] in idset), key=lambda t: rank[t["id"]]
        )
        if not moving:
            abort(404, "no matching tasks")
        rest = [t for t in p["tasks"] if t["id"] not in idset]
        if status is not None:
            for t in moving:
                t["status"] = status
        idx = len(rest)
        if before:
            for i, t in enumerate(rest):
                if t["id"] == before:
                    idx = i
                    break
        p["tasks"] = rest[:idx] + moving + rest[idx:]
        save()
        return jsonify(p)


# --- notes (many per task) ------------------------------------------

@app.post("/api/tasks/<tid>/notes")
def add_note(tid):
    text = (body().get("text") or "").strip()
    if not text:
        abort(400, "text required")
    with _lock:
        _, t = find_task(tid)
        if not t:
            abort(404)
        note = {"id": new_id(), "text": text, "created": now_iso()}
        t["notes"].append(note)
        save()
    return jsonify(note), 201


@app.delete("/api/tasks/<tid>/notes/<nid>")
def delete_note(tid, nid):
    with _lock:
        _, t = find_task(tid)
        if not t:
            abort(404)
        kept = [n for n in t["notes"] if n["id"] != nid]
        if len(kept) == len(t["notes"]):
            abort(404)
        t["notes"] = kept
        save()
    return "", 204


@app.errorhandler(400)
@app.errorhandler(404)
def json_error(e):
    return jsonify(error=getattr(e, "description", str(e))), e.code


if __name__ == "__main__":
    load()
    port = int(os.environ.get("PORT", "5001"))
    print(f"Task tracker running at http://localhost:{port}  (Ctrl+C to stop)")
    app.run(host="127.0.0.1", port=port, threaded=True)
