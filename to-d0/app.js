"use strict";

/* ════════════════════════════════════════════════════════════════════
   CONFIG — everything environment-specific lives here.
   ⚠️ SECURITY: putting a client_secret in browser JS exposes it to
   anyone who opens DevTools. Acceptable ONLY for a throwaway trial /
   learning setup. For anything real, put an approuter or backend
   proxy in front and let it handle OAuth server-side.
   Also: rotate the service key you previously shared — recreate it in
   your BTP cockpit and paste the new values below.
   ════════════════════════════════════════════════════════════════════ */
const CONFIG = {
  // XSUAA token endpoint (from your service key: url + "/oauth/token")
  tokenUrl:
    "https://b1d9f557trial.authentication.us10.hana.ondemand.com/oauth/token",
  clientId: "sb-todo-b1d9f557trial-dev!t649277",
  clientSecret: "3faa32a6-bd02-4a2a-8436-6e9632c22d93$CwmZh64ty7pMN9Oj6R8E1w0-YUwbudiOYDCb-iIaiDo=",

  // CAP OData V4 entity set URL, e.g.
  // https://<app>.cfapps.us10.hana.ondemand.com/odata/v4/todo/ToDo
  odataUrl:
    "https://b1d9f557trial-dev-todo-srv.cfapps.us10-001.hana.ondemand.com/odata/v4/to-do-/ToDo",

  // Field names in your CDS entity — adjust if yours differ.
  fields: {
    id: "ID",          // key, Edm.Guid (cuid aspect)
    title: "title",    // String
    completed: "completed", // Boolean
  },

  // Set false if your service runs without auth (e.g. local `cds watch`)
  useAuth: true,
};

/* ── 1. Bearer token (cached until near expiry) ─────────────────── */
let tokenCache = { token: null, expiresAt: 0 };

async function getBearerToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
  });
  const res = await fetch(CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Token fetch failed: ${res.status} — ${await res.text()}`);
  }
  const data = await res.json();
  // refresh 60s before actual expiry
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return tokenCache.token;
}

/* ── 2. Generic OData request helper ────────────────────────────── */
async function odata(method, path = "", body = null) {
  const headers = { Accept: "application/json" };
  if (CONFIG.useAuth) {
    headers.Authorization = `Bearer ${await getBearerToken()}`;
  }
  if (body !== null) headers["Content-Type"] = "application/json";

  const res = await fetch(CONFIG.odataUrl + path, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.parse(detail)?.error?.message || detail;
    } catch (_) { /* keep raw text */ }
    throw new Error(`${method} ${res.status}: ${detail}`);
  }
  // DELETE and some PATCH responses are 204 No Content
  return res.status === 204 ? null : res.json();
}

/* OData V4: Edm.Guid keys go in parentheses WITHOUT quotes */
const keyPath = (id) => `(${id})`;

/* ── 3. CRUD operations ─────────────────────────────────────────── */
const api = {
  list: () =>
    odata("GET", `?$orderby=${CONFIG.fields.completed} asc`).then(
      (d) => d.value
    ),
  create: (title) =>
    odata("POST", "", {
      [CONFIG.fields.title]: title,
      [CONFIG.fields.completed]: false,
    }),
  setCompleted: (id, completed) =>
    odata("PATCH", keyPath(id), { [CONFIG.fields.completed]: completed }),
  rename: (id, title) =>
    odata("PATCH", keyPath(id), { [CONFIG.fields.title]: title }),
  remove: (id) => odata("DELETE", keyPath(id)),
};

/* ── 4. DOM references & state ──────────────────────────────────── */
const els = {
  input: document.getElementById("taskInput"),
  addBtn: document.getElementById("addBtn"),
  list: document.getElementById("taskList"),
  empty: document.getElementById("emptyState"),
  loading: document.getElementById("loadingState"),
  banner: document.getElementById("banner"),
  counterOpen: document.getElementById("counterOpen"),
};

let tasks = [];

/* ── 5. Rendering ───────────────────────────────────────────────── */
function render() {
  const f = CONFIG.fields;
  els.list.innerHTML = "";
  els.empty.hidden = tasks.length !== 0;
  els.counterOpen.textContent = tasks.filter((t) => !t[f.completed]).length;

  for (const task of tasks) {
    const li = document.createElement("li");
    li.className = "task" + (task[f.completed] ? " done" : "");
    li.dataset.id = task[f.id];

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-check";
    check.checked = !!task[f.completed];
    check.setAttribute("aria-label", "Mark task complete");
    check.addEventListener("change", () =>
      handleToggle(task[f.id], check.checked)
    );

    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = task[f.title];
    title.addEventListener("dblclick", () => startEdit(li, task));

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "edit-btn";
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => startEdit(li, task));

    const delBtn = document.createElement("button");
    delBtn.className = "del-btn";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => handleDelete(task[f.id]));

    actions.append(editBtn, delBtn);
    li.append(check, title, actions);
    els.list.appendChild(li);
  }
}

function showError(msg) {
  els.banner.textContent = msg;
  els.banner.hidden = false;
  clearTimeout(showError._t);
  showError._t = setTimeout(() => (els.banner.hidden = true), 6000);
}

/* ── 6. Handlers ────────────────────────────────────────────────── */
async function loadTasks() {
  els.loading.hidden = false;
  try {
    tasks = await api.list();
    render();
  } catch (err) {
    showError(`Couldn't load tasks. ${err.message}`);
  } finally {
    els.loading.hidden = true;
  }
}

async function handleAdd() {
  const title = els.input.value.trim();
  if (!title) return;
  els.addBtn.disabled = true;
  try {
    const created = await api.create(title);
    tasks.push(created);
    els.input.value = "";
    render();
    els.input.focus();
  } catch (err) {
    showError(`Couldn't add the task. ${err.message}`);
  } finally {
    els.addBtn.disabled = false;
  }
}

async function handleToggle(id, completed) {
  const f = CONFIG.fields;
  const task = tasks.find((t) => t[f.id] === id);
  const previous = task[f.completed];
  task[f.completed] = completed; // optimistic
  render();
  try {
    await api.setCompleted(id, completed);
  } catch (err) {
    task[f.completed] = previous; // roll back
    render();
    showError(`Couldn't update the task. ${err.message}`);
  }
}

function startEdit(li, task) {
  const f = CONFIG.fields;
  const titleEl = li.querySelector(".task-title");
  if (!titleEl) return; // already editing

  const editor = document.createElement("input");
  editor.type = "text";
  editor.className = "task-edit-input";
  editor.value = task[f.title];
  editor.maxLength = 200;
  titleEl.replaceWith(editor);
  editor.focus();
  editor.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const newTitle = editor.value.trim();
    if (save && newTitle && newTitle !== task[f.title]) {
      const previous = task[f.title];
      task[f.title] = newTitle; // optimistic
      render();
      try {
        await api.rename(task[f.id], newTitle);
      } catch (err) {
        task[f.title] = previous;
        render();
        showError(`Couldn't rename the task. ${err.message}`);
      }
    } else {
      render();
    }
  };

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  editor.addEventListener("blur", () => finish(true));
}

async function handleDelete(id) {
  const f = CONFIG.fields;
  const removed = tasks.find((t) => t[f.id] === id);
  tasks = tasks.filter((t) => t[f.id] !== id); // optimistic
  render();
  try {
    await api.remove(id);
  } catch (err) {
    tasks.push(removed); // roll back
    render();
    showError(`Couldn't delete the task. ${err.message}`);
  }
}

/* ── 7. Wire up ─────────────────────────────────────────────────── */
els.addBtn.addEventListener("click", handleAdd);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleAdd();
});

loadTasks();