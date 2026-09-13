"use strict";

const appEl = document.getElementById("app");
const crumbEl = document.getElementById("crumb");

// --- theme toggle (overrides the OS/browser prefers-color-scheme setting) ---
const THEME_KEY = "theme"; // localStorage: "light" | "dark" | absent = follow system

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch (_) {
    return null;
  }
}
function systemPrefersDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function currentTheme() {
  return storedTheme() || (systemPrefersDark() ? "dark" : "light");
}
function applyTheme() {
  const stored = storedTheme();
  if (stored) document.documentElement.setAttribute("data-theme", stored);
  else document.documentElement.removeAttribute("data-theme");

  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const isDark = currentTheme() === "dark";
  btn.textContent = isDark ? "☀️" : "🌙";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}
document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_) {}
  applyTheme();
});
applyTheme();

const COLUMNS = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
];

const PREVIEW_NOTES = 3; // how many notes to show on a collapsed card

// --- per-board UI state (kept across re-renders, reset on project change) ---
const expanded = new Set(); // task ids whose detail panel is open
const selected = new Set(); // task ids selected for multi-drag
let lastClickedId = null; // anchor for shift-click ranges
let boardPid = null;

// --- helpers ------------------------------------------------------------

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("/api" + path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

// Tiny hyperscript: el("div", {class: "x", onclick: fn}, child, child)
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// due is stored as "YYYY-MM-DDTHH:MM" (older data may be date-only)
function dueInputValue(due) {
  if (!due) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? due + "T00:00" : due;
}
function fmtDue(due) {
  const iso = dueInputValue(due);
  const d = new Date(iso);
  if (isNaN(d)) return due;
  const datePart = d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  const hasTime = !/T00:00(:00)?$/.test(iso);
  return hasTime
    ? datePart + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : datePart;
}
function isOverdue(due) {
  const d = new Date(dueInputValue(due));
  return !isNaN(d) && d.getTime() < Date.now();
}

// "google.com" -> "https://google.com"; leaves real URLs (and mailto:/tel:) alone
function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  return /^[a-z][a-z0-9+.\-]*:\/\//i.test(u) || /^(mailto|tel):/i.test(u) ? u : "https://" + u;
}
function urlLabel(u) {
  return normalizeUrl(u)
    .replace(/^[a-z][a-z0-9+.\-]*:\/\//i, "")
    .replace(/\/$/, "");
}

// Every distinct label used anywhere on the board, so a label typed once
// becomes a pickable option everywhere else.
function boardLabels(project) {
  const set = new Set();
  for (const t of project.tasks) if (t.label) set.add(t.label);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Fixed categorical palette (see style.css :root) — a label's color is derived
// from its own text via a stable hash, so the same label name always lands on
// the same slot everywhere (card badges, the stats legend, the pie chart).
const LABEL_PALETTE = [
  "var(--label-1)",
  "var(--label-2)",
  "var(--label-3)",
  "var(--label-4)",
  "var(--label-5)",
  "var(--label-6)",
];
function labelColor(name) {
  if (!name) return null;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return LABEL_PALETTE[Math.abs(hash) % LABEL_PALETTE.length];
}

function applySelection() {
  appEl.querySelectorAll(".card").forEach((c) => {
    c.classList.toggle("selected", selected.has(c.dataset.tid));
  });
}

function updateSelHint() {
  const selHint = document.querySelector(".sel-hint");
  if (!selHint) return;
  selHint.innerHTML = "";
  if (selected.size) {
    selHint.classList.remove("muted");
    selHint.append(
      `${selected.size} selected — drag any card to move them together`,
      el("button", {
        class: "link-btn",
        text: "clear",
        onclick: () => {
          selected.clear();
          applySelection();
          updateSelHint();
        },
      })
    );
  } else {
    selHint.classList.add("muted");
    selHint.append(
      "Tip: Ctrl/Cmd-click or Shift-click cards to select several, then drag them at once. Click anywhere empty to deselect."
    );
  }
}

// Relocate/reorder tasks: move `ids` into `status`, inserted before task `before`
// (or appended to that column when `before` is null).
async function moveTasks(pid, ids, status, before) {
  ids = ids.filter(Boolean);
  if (!ids.length) return;
  try {
    await api("POST", `/projects/${pid}/tasks/move`, { ids, status, before });
    selected.clear();
    renderBoard(pid);
  } catch (e) {
    alert(e.message);
  }
}

function fail(where, err) {
  appEl.innerHTML = "";
  appEl.append(el("p", { class: "error", text: `${where}: ${err.message}` }));
}

// --- routing ----------------------------------------------------------

function router() {
  const hash = location.hash || "#/";
  const stats = hash.match(/^#\/project\/([^/]+)\/stats$/);
  const board = hash.match(/^#\/project\/([^/]+)$/);
  if (stats) renderStats(stats[1]);
  else if (board) renderBoard(board[1]);
  else renderProjects();
}
window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);

// A click that isn't inside a card drops the current selection.
document.addEventListener("click", (e) => {
  if (!selected.size || e.target.closest(".card")) return;
  selected.clear();
  applySelection();
  updateSelHint();
});

// Let people highlight & copy note text: a card is draggable="true", so a
// mousedown on it would start a drag instead of a selection. While the pointer
// is pressed on note text, turn the card's drag off, then restore it.
appEl.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".note-text")) return;
  const card = e.target.closest(".card");
  if (card) card.setAttribute("draggable", "false");
});
document.addEventListener("pointerup", () => {
  appEl
    .querySelectorAll('.card[draggable="false"]')
    .forEach((c) => c.setAttribute("draggable", "true"));
});

// --- project list ---------------------------------------------------

async function renderProjects() {
  crumbEl.innerHTML = "";
  crumbEl.append(el("a", { href: "#/", text: "Task Tracker" }));

  let projects;
  try {
    projects = await api("GET", "/projects");
  } catch (e) {
    return fail("Failed to load projects", e);
  }

  appEl.innerHTML = "";

  const form = el(
    "form",
    {
      class: "add-row",
      onsubmit: async (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        const name = input.value.trim();
        if (!name) return;
        try {
          const p = await api("POST", "/projects", { name });
          location.hash = `#/project/${p.id}`;
        } catch (err) {
          alert(err.message);
        }
      },
    },
    el("input", { type: "text", placeholder: "New project name", "aria-label": "New project name" }),
    el("button", { type: "submit", text: "Add project" })
  );
  appEl.append(form);

  if (!projects.length) {
    appEl.append(el("p", { class: "empty", text: "No projects yet. Add one above." }));
    return;
  }

  const list = el("ul", { class: "project-list" });
  for (const p of projects) {
    list.append(
      el(
        "li",
        { class: "project-card" },
        el("a", { href: `#/project/${p.id}`, class: "project-name", text: p.name }),
        el("span", { class: "project-meta", text: `${p.openCount} open / ${p.taskCount} total` }),
        el("button", {
          class: "link-btn danger",
          text: "Delete",
          onclick: async () => {
            if (!confirm(`Delete project "${p.name}" and all its tasks?`)) return;
            try {
              await api("DELETE", `/projects/${p.id}`);
              renderProjects();
            } catch (err) {
              alert(err.message);
            }
          },
        })
      )
    );
  }
  appEl.append(list);
}

// --- board --------------------------------------------------------

async function renderBoard(pid) {
  let project;
  try {
    project = await api("GET", `/projects/${pid}`);
  } catch (e) {
    return fail("Failed to load project", e);
  }

  if (pid !== boardPid) {
    expanded.clear();
    selected.clear();
    lastClickedId = null;
    boardPid = pid;
  }

  crumbEl.innerHTML = "";
  crumbEl.append(
    el("a", { href: "#/", text: "Task Tracker" }),
    el("span", { class: "sep", text: "/" }),
    el("span", { text: project.name })
  );

  appEl.innerHTML = "";

  const labelListId = "board-labels";
  const labelList = el("datalist", { id: labelListId });
  for (const l of boardLabels(project)) labelList.append(el("option", { value: l }));
  appEl.append(labelList);

  const newTitle = el("input", {
    type: "text",
    class: "new-task-title",
    placeholder: "New task — added to To Do",
    "aria-label": "New task",
  });
  const newLabel = el("input", {
    type: "text",
    class: "new-task-label",
    placeholder: "Label (optional)",
    "aria-label": "Label",
    list: labelListId,
  });
  const newUrl = el("input", {
    // plain text, not type="url" — that form-validates on submit and would
    // silently block adding a task for a bare "example.com" (no scheme)
    type: "text",
    class: "new-task-url",
    placeholder: "Link (optional)",
    "aria-label": "Link",
  });
  const topRow = el(
    "div",
    { class: "board-top-row" },
    el(
      "form",
      {
        class: "add-row",
        onsubmit: async (e) => {
          e.preventDefault();
          const title = newTitle.value.trim();
          if (!title) return;
          try {
            await api("POST", `/projects/${pid}/tasks`, {
              title,
              label: newLabel.value.trim() || null,
              url: newUrl.value.trim() || null,
            });
            await renderBoard(pid);
            const next = appEl.querySelector(".add-row .new-task-title");
            if (next) next.focus(); // keep typing the next task
          } catch (err) {
            alert(err.message);
          }
        },
      },
      newTitle,
      newLabel,
      newUrl,
      el("button", { type: "submit", text: "Add task" })
    ),
    el("a", { href: `#/project/${pid}/stats`, class: "btn stats-btn", text: "📊 Stats" })
  );
  appEl.append(topRow);

  appEl.append(el("div", { class: "sel-hint" }));
  updateSelHint();

  const board = el("div", { class: "board" });
  for (const col of COLUMNS) {
    const tasks = project.tasks.filter((t) => t.status === col.key);
    const columnIds = tasks.map((t) => t.id);
    const column = el(
      "div",
      {
        class: "column",
        "data-status": col.key,
        ondragover: (e) => {
          e.preventDefault();
          column.classList.add("drag-over");
        },
        ondragleave: () => column.classList.remove("drag-over"),
        ondrop: (e) => {
          // drop on the column background = append to the end of this column
          e.preventDefault();
          column.classList.remove("drag-over");
          const ids = (e.dataTransfer.getData("text/plain") || "").split(",");
          moveTasks(pid, ids, col.key, null);
        },
      },
      el("h2", {}, col.label, el("span", { class: "count", text: String(tasks.length) }))
    );
    if (!tasks.length) column.append(el("div", { class: "column-empty", text: "Drop tasks here" }));
    for (const t of tasks) column.append(taskCard(pid, t, columnIds, labelListId));
    board.append(column);
  }
  appEl.append(board);
  applySelection();
}

// --- task card ---------------------------------------------------

async function copyText(text, btn) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = el("textarea", { style: "position:fixed;opacity:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    const prev = btn.textContent;
    btn.textContent = "✓";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove("copied");
    }, 900);
  } catch (err) {
    alert("Couldn't copy: " + err.message);
  }
}

function noteRow(pid, t, n, withDelete) {
  return el(
    "div",
    { class: "note" },
    el("span", { class: "note-text", text: n.text }),
    el("button", {
      class: "link-btn note-copy",
      text: "⧉",
      title: "Copy note",
      onclick: (e) => {
        e.stopPropagation();
        copyText(n.text, e.currentTarget);
      },
    }),
    withDelete &&
      el("button", {
        class: "link-btn danger note-del",
        text: "×",
        title: "Delete note",
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await api("DELETE", `/tasks/${t.id}/notes/${n.id}`);
            renderBoard(pid);
          } catch (err) {
            alert(err.message);
          }
        },
      })
  );
}

function taskCard(pid, t, columnIds, labelListId) {
  const isOpen = expanded.has(t.id);
  const notes = t.notes || [];

  // --- collapsed preview: last few notes, hidden while expanded ---
  const preview = el("div", { class: "notes-preview", hidden: isOpen || !notes.length });
  if (notes.length > PREVIEW_NOTES) {
    preview.append(el("div", { class: "notes-more", text: `+${notes.length - PREVIEW_NOTES} earlier` }));
  }
  for (const n of notes.slice(-PREVIEW_NOTES)) preview.append(noteRow(pid, t, n, false));

  // --- inline "add a comment" bar, shown only on the collapsed card ---
  const quickNote = el(
    "form",
    {
      class: "quick-note",
      hidden: isOpen,
      onsubmit: async (e) => {
        e.preventDefault();
        const i = quickNote.querySelector("input");
        const text = i.value.trim();
        if (!text) return;
        try {
          await api("POST", `/tasks/${t.id}/notes`, { text });
          await renderBoard(pid);
          const again = appEl.querySelector(`[data-tid="${t.id}"] .quick-note input`);
          if (again) again.focus();
        } catch (err) {
          alert(err.message);
        }
      },
    },
    el("input", { type: "text", placeholder: "Add a comment…", "aria-label": "Add a comment" }),
    el("button", { type: "submit", text: "Add" })
  );

  // --- detail panel ---
  const detail = el("div", { class: "card-detail", hidden: !isOpen });

  const titleInput = el("input", {
    type: "text",
    class: "title-input",
    value: t.title,
    "aria-label": "Task title",
    onchange: async () => {
      const v = titleInput.value.trim();
      if (!v || v === t.title) {
        titleInput.value = t.title;
        return;
      }
      try {
        await api("PATCH", `/tasks/${t.id}`, { title: v });
        renderBoard(pid);
      } catch (e) {
        alert(e.message);
      }
    },
  });
  detail.append(
    el("div", { class: "field" }, el("span", { class: "field-label", text: "Title" }), titleInput)
  );

  const dueDate = el("input", { type: "date", value: dueInputValue(t.due).slice(0, 10) });
  const dueTime = el("input", { type: "time", value: dueInputValue(t.due).slice(11, 16) });
  const saveDue = async () => {
    const val = dueDate.value ? dueDate.value + "T" + (dueTime.value || "00:00") : null;
    try {
      await api("PATCH", `/tasks/${t.id}`, { due: val });
      renderBoard(pid);
    } catch (e) {
      alert(e.message);
    }
  };
  dueDate.addEventListener("change", saveDue);
  dueTime.addEventListener("change", saveDue);
  detail.append(
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label", text: "Due" }),
      dueDate,
      dueTime,
      t.due &&
        el("button", {
          class: "link-btn",
          text: "clear",
          onclick: async (e) => {
            e.stopPropagation();
            try {
              await api("PATCH", `/tasks/${t.id}`, { due: null });
              renderBoard(pid);
            } catch (err) {
              alert(err.message);
            }
          },
        })
    )
  );

  const urlInput = el("input", {
    type: "url",
    class: "url-input",
    placeholder: "https://…  (e.g. Zendesk ticket)",
    value: t.url || "",
    onchange: async () => {
      try {
        await api("PATCH", `/tasks/${t.id}`, { url: normalizeUrl(urlInput.value) || null });
        renderBoard(pid);
      } catch (e) {
        alert(e.message);
      }
    },
  });
  detail.append(
    el("div", { class: "field" }, el("span", { class: "field-label", text: "Link" }), urlInput)
  );

  const labelDot = el("span", {
    class: "label-dot",
    hidden: !t.label,
    style: t.label ? `background:${labelColor(t.label)}` : "",
  });
  const labelInput = el("input", {
    type: "text",
    class: "label-input",
    placeholder: "No label",
    "aria-label": "Label",
    value: t.label || "",
    list: labelListId,
    onchange: async () => {
      const name = labelInput.value.trim();
      try {
        await api("PATCH", `/tasks/${t.id}`, { label: name || null });
        renderBoard(pid);
      } catch (e) {
        alert(e.message);
      }
    },
  });
  detail.append(
    el(
      "div",
      { class: "field" },
      el("span", { class: "field-label", text: "Label" }),
      labelDot,
      labelInput,
      t.label &&
        el("button", {
          class: "link-btn",
          text: "clear",
          onclick: async (e) => {
            e.stopPropagation();
            try {
              await api("PATCH", `/tasks/${t.id}`, { label: null });
              renderBoard(pid);
            } catch (err) {
              alert(err.message);
            }
          },
        })
    )
  );

  const allNotes = el("div", { class: "notes-all" });
  for (const n of notes) allNotes.append(noteRow(pid, t, n, true));
  detail.append(allNotes);

  const addNote = el(
    "form",
    {
      class: "add-row small add-note",
      onsubmit: async (e) => {
        e.preventDefault();
        const i = addNote.querySelector("input");
        const text = i.value.trim();
        if (!text) return;
        try {
          await api("POST", `/tasks/${t.id}/notes`, { text });
          await renderBoard(pid);
          const again = appEl.querySelector(`[data-tid="${t.id}"] .add-note input`);
          if (again) again.focus();
        } catch (err) {
          alert(err.message);
        }
      },
    },
    el("input", { type: "text", placeholder: "Add a note", "aria-label": "Add a note" }),
    el("button", { type: "submit", text: "Add" })
  );
  detail.append(addNote);

  detail.append(
    el("button", {
      class: "link-btn danger",
      text: "Delete task",
      onclick: async () => {
        if (!confirm("Delete this task?")) return;
        try {
          expanded.delete(t.id);
          selected.delete(t.id);
          await api("DELETE", `/tasks/${t.id}`);
          renderBoard(pid);
        } catch (e) {
          alert(e.message);
        }
      },
    })
  );

  // --- header ---
  const overdue = t.due && t.status !== "done" && isOverdue(t.due);

  const toggle = el("button", {
    class: "card-toggle link-btn",
    text: isOpen ? "▾ Details" : "▸ Details",
    onclick: (e) => {
      e.stopPropagation();
      const open = !expanded.has(t.id);
      if (open) expanded.add(t.id);
      else expanded.delete(t.id);
      detail.hidden = !open;
      preview.hidden = open || !notes.length;
      quickNote.hidden = open;
      toggle.textContent = open ? "▾ Details" : "▸ Details";
    },
  });

  const badges = el("div", { class: "card-badges" });
  if (t.due) {
    badges.append(
      el("span", { class: "badge" + (overdue ? " overdue" : ""), text: "📅 " + fmtDue(t.due) })
    );
  }
  if (t.url) {
    const href = normalizeUrl(t.url);
    badges.append(
      el("a", {
        class: "badge link",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        title: href,
        text: "🔗 " + urlLabel(t.url),
        onclick: (e) => e.stopPropagation(),
      })
    );
  }
  if (notes.length) badges.append(el("span", { class: "badge", text: "💬 " + notes.length }));
  if (t.label) {
    badges.append(
      el(
        "span",
        { class: "badge label-badge" },
        el("span", { class: "label-dot", style: `background:${labelColor(t.label)}` }),
        t.label
      )
    );
  }

  const head = el(
    "div",
    {
      class: "card-head",
      onclick: (e) => {
        if (e.target.closest(".card-toggle")) return;
        if (e.shiftKey && lastClickedId && columnIds.includes(lastClickedId)) {
          const a = columnIds.indexOf(lastClickedId);
          const b = columnIds.indexOf(t.id);
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) selected.add(columnIds[i]);
        } else if (e.metaKey || e.ctrlKey) {
          if (selected.has(t.id)) selected.delete(t.id);
          else selected.add(t.id);
          lastClickedId = t.id;
        } else {
          if (selected.size === 1 && selected.has(t.id)) selected.clear();
          else {
            selected.clear();
            selected.add(t.id);
          }
          lastClickedId = t.id;
        }
        applySelection();
        updateSelHint();
      },
    },
    el(
      "div",
      { class: "card-row-main" },
      el("span", { class: "card-title", text: t.title }),
      toggle
    ),
    badges.childNodes.length ? badges : null
  );

  const card = el(
    "div",
    {
      class: "card",
      "data-tid": t.id,
      draggable: "true",
      ondragstart: (e) => {
        const ids = selected.has(t.id) && selected.size > 1 ? [...selected] : [t.id];
        e.dataTransfer.setData("text/plain", ids.join(","));
        e.dataTransfer.effectAllowed = "move";
        ids.forEach((id) => {
          const c = appEl.querySelector(`[data-tid="${id}"]`);
          if (c) c.classList.add("dragging");
        });
      },
      ondragend: () => {
        appEl.querySelectorAll(".card.dragging").forEach((c) => c.classList.remove("dragging"));
        appEl.querySelectorAll(".card.drop-above, .card.drop-below")
          .forEach((c) => c.classList.remove("drop-above", "drop-below"));
      },
      ondragover: (e) => {
        if (card.classList.contains("dragging")) return; // not onto a card being dragged
        e.preventDefault();
        e.stopPropagation(); // the column shouldn't also handle it
        const rect = card.getBoundingClientRect();
        const below = e.clientY - rect.top > rect.height / 2;
        card.classList.toggle("drop-below", below);
        card.classList.toggle("drop-above", !below);
      },
      ondragleave: (e) => {
        e.stopPropagation();
        card.classList.remove("drop-above", "drop-below");
      },
      ondrop: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const below = card.classList.contains("drop-below");
        card.classList.remove("drop-above", "drop-below");
        const ids = (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
        if (!ids.length || ids.includes(t.id)) return;
        // express the drop position as "insert before <id>" within this column
        const i = columnIds.indexOf(t.id);
        const beforeId = below ? columnIds[i + 1] || null : t.id;
        moveTasks(pid, ids, t.status, beforeId);
      },
    },
    head,
    preview,
    quickNote,
    detail
  );
  return card;
}

// --- stats page -----------------------------------------------------

const OTHER_SLICE_COLOR = "var(--muted)";
const MAX_SLICES = 6; // more than this and adjacent wedges blur together — fold the tail into "Other"

function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

// SVG arcs can't span a full 360°, so a single-category pie is drawn as two half-arcs.
function pieSlicePath(cx, cy, r, startAngle, endAngle) {
  if (endAngle - startAngle >= 359.999) {
    const top = polarToCartesian(cx, cy, r, 0);
    const bottom = polarToCartesian(cx, cy, r, 180);
    return `M ${top.x} ${top.y} A ${r} ${r} 0 1 1 ${bottom.x} ${bottom.y} A ${r} ${r} 0 1 1 ${top.x} ${top.y} Z`;
  }
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

async function renderStats(pid) {
  let project;
  try {
    project = await api("GET", `/projects/${pid}`);
  } catch (e) {
    return fail("Failed to load project", e);
  }

  crumbEl.innerHTML = "";
  crumbEl.append(
    el("a", { href: "#/", text: "Task Tracker" }),
    el("span", { class: "sep", text: "/" }),
    el("a", { href: `#/project/${pid}`, text: project.name }),
    el("span", { class: "sep", text: "/" }),
    el("span", { text: "Stats" })
  );

  appEl.innerHTML = "";
  appEl.append(el("a", { href: `#/project/${pid}`, class: "link-btn back-link", text: "← Back to board" }));

  if (!project.tasks.length) {
    appEl.append(el("p", { class: "empty", text: "No tickets yet." }));
    return;
  }

  // count tickets per label; a ticket with no label counts toward "Unlabeled"
  const counts = new Map();
  let unlabeled = 0;
  for (const t of project.tasks) {
    if (!t.label) {
      unlabeled++;
      continue;
    }
    counts.set(t.label, (counts.get(t.label) || 0) + 1);
  }

  let entries = [...counts.entries()].map(([name, count]) => ({ name, count, isOther: false }));
  if (unlabeled) entries.push({ name: "Unlabeled", count: unlabeled, isOther: false });
  entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  if (entries.length > MAX_SLICES) {
    const kept = entries.slice(0, MAX_SLICES - 1);
    const rest = entries.slice(MAX_SLICES - 1);
    kept.push({ name: "Other", count: rest.reduce((s, e) => s + e.count, 0), isOther: true });
    entries = kept;
  }

  // same label -> same color everywhere; "Unlabeled" and the folded "Other"
  // bucket use the neutral tone since they aren't real labels.
  for (const e of entries) {
    e.color = e.isOther || e.name === "Unlabeled" ? OTHER_SLICE_COLOR : labelColor(e.name);
  }

  const total = entries.reduce((s, e) => s + e.count, 0);
  appEl.append(
    el("h2", { class: "stats-title", text: `${total} ticket${total === 1 ? "" : "s"} by label` })
  );

  const hoverInfo = el("p", { class: "pie-hover muted", text: "Hover or focus a slice for details" });

  function setHover(e) {
    const pct = Math.round((e.count / total) * 100);
    hoverInfo.textContent = `${e.name}: ${e.count} ticket${e.count === 1 ? "" : "s"} (${pct}%)`;
    appEl.querySelectorAll("[data-slice-name], [data-legend-name]").forEach((node) => {
      const name = node.dataset.sliceName ?? node.dataset.legendName;
      node.classList.toggle("hovered", name === e.name);
    });
  }
  function clearHover() {
    hoverInfo.textContent = "Hover or focus a slice for details";
    appEl.querySelectorAll(".hovered").forEach((node) => node.classList.remove("hovered"));
  }

  const size = 220, cx = size / 2, cy = size / 2, r = 96;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${size} ${size}`,
    class: "pie-chart",
    role: "img",
    "aria-label": `Ticket counts by label: ${entries.map((e) => `${e.name} ${e.count}`).join(", ")}`,
  });
  let angle = 0;
  for (const e of entries) {
    const start = angle;
    angle += (e.count / total) * 360;
    svg.append(
      svgEl("path", {
        d: pieSlicePath(cx, cy, r, start, angle),
        fill: e.color,
        class: "pie-slice",
        "data-slice-name": e.name,
        tabindex: "0",
        role: "img",
        "aria-label": `${e.name}: ${e.count} ticket${e.count === 1 ? "" : "s"}`,
        onmouseenter: () => setHover(e),
        onfocus: () => setHover(e),
        onmouseleave: clearHover,
        onblur: clearHover,
      })
    );
  }

  const legend = el(
    "table",
    { class: "stats-table" },
    el(
      "thead",
      {},
      el("tr", {}, el("th", { text: "Label" }), el("th", { text: "Tickets" }), el("th", { text: "Share" }))
    ),
    el(
      "tbody",
      {},
      entries.map((e) =>
        el(
          "tr",
          {
            "data-legend-name": e.name,
            onmouseenter: () => setHover(e),
            onmouseleave: clearHover,
          },
          el(
            "td",
            {},
            el("span", { class: "legend-swatch", style: `background:${e.color}` }),
            e.name
          ),
          el("td", { text: String(e.count) }),
          el("td", { text: `${Math.round((e.count / total) * 100)}%` })
        )
      )
    )
  );

  appEl.append(
    el(
      "div",
      { class: "stats-layout" },
      el("div", { class: "pie-wrap" }, svg, hoverInfo),
      legend
    )
  );
}
