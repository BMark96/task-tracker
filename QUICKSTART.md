# Quickstart

## Start it

```sh
./run.sh
```

Your browser opens at <http://localhost:5001>. The **first** run takes ~10 seconds
to create a local `.venv` and install Flask; every run after that starts instantly.

Stop it with **Ctrl+C** in the terminal.

Prefer a Finder double-click instead of the terminal? `cp run.sh run.command` and
double-click that.

## Use it

1. **Add a project** — type a name, click **Add project**. It opens that project's board.
2. **Add tasks** — type a task title, click **Add task** (or press Enter). It lands in
   **To Do**. The box stays focused so you can rattle off several in a row.
3. **Add a comment** — every card has an **Add a comment…** bar; type and press Enter
   without opening the card.
4. **Move / reorder a task** — **drag** its card between **To Do → In Progress →
   Blocked → Done** (each column has its own colour). Drop it on the top or bottom
   half of another card to place it there (a blue line shows where it lands); drop on
   empty column space to send it to the end. To move several at once, **Ctrl/Cmd-click**
   or **Shift-click** cards to select them, then drag any one of them. Click any empty
   space to clear the selection.
5. **Task details** — click the **▸ Details** button on a card to open it:
   - **Due date & time** — separate date and time fields (time optional). The badge
     on the card turns red once it's past due; **clear** removes it.
   - **Link** — an optional URL. A bare domain like `example.com/path` is fine — it's
     saved as `https://…` and shown on the card.
   - **Notes / comments** — add as many as you like. The latest 3 show on the
     collapsed card (with a "+N earlier" hint); open Details to read and delete all.
   - **Delete task**.
6. **Navigate** — click **Task Tracker** (top-left) to go back to the project list.
   Each project there has its own **Delete**.

## Your data

Everything you enter lives in **`tasks.json`** next to `server.py` — no database.
It's plain JSON and safe to hand-edit **while the server is stopped**.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Address already in use` / port 5001 taken | `PORT=8080 ./run.sh` |
| `permission denied: ./run.sh` | `chmod +x run.sh` |
| Wrong/old Python picked up, or install errors | delete the `.venv/` folder and re-run |
| `python3: command not found` | `xcode-select --install`, then re-run |
