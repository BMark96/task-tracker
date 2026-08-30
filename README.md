# task-tracker

A tiny local task tracker: a project list, and per project a board with
**To Do / In Progress / Blocked / Done** columns. Tasks have a title, a due date
and time, an optional link, and any number of notes (the latest few show on the
card). Drag cards between columns or reorder them within a column — select several
with Ctrl/Cmd- or Shift-click to move them together.

- **Backend:** one file, `server.py` (Flask). Only dependency: Flask.
- **Storage:** `tasks.json` next to `server.py`. No database.
- **Frontend:** plain HTML/CSS/JS in `static/`. No build step.

## Run

Quick version — `./run.sh` (first run sets up a `.venv` and installs Flask, then
opens <http://localhost:5001>). See [`QUICKSTART.md`](QUICKSTART.md) for day-to-day use.

Manual version — needs Python 3.8+ (`python3` ships with the Xcode Command Line
Tools):

```sh
cd task-tracker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py            # PORT=8080 python server.py for another port
```

To skip the virtualenv entirely: `pip install --user Flask` once, then just
`python3 server.py`.

## Data format

`tasks.json`:

```json
{
  "projects": [
    {
      "id": "0b8f1c9e-4d2a-4a1b-9c3e-7f6a2d5b8e10",
      "name": "Website redesign",
      "created": "2026-08-30T12:00:00Z",
      "tasks": [
        {
          "id": "3a7c2f11-8e94-4b6d-a1c2-9d0e5f4b3a21",
          "title": "Draft homepage copy",
          "status": "todo",
          "due": "2026-09-05T14:30",
          "url": "https://example.com/ticket/1234",
          "notes": [
            { "id": "c6d1...", "text": "Waiting on brand guide", "created": "2026-08-30T12:05:00Z" }
          ],
          "created": "2026-08-30T12:00:00Z"
        }
      ]
    }
  ]
}
```

Ids are UUIDs. The order of the `tasks` array is the order cards appear in their
column. `status` is one of `todo`, `in_progress`, `blocked`, `done`. `due` is a
`YYYY-MM-DDTHH:MM` local datetime or `null`. `url` is a string or `null`. `notes` is a
list, newest last. It's safe to hand-edit the file while the server is stopped.
