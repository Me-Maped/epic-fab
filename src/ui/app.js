"use strict";

/* epic-fab UI — vanilla JS, same-origin fetch, no build step. */

const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  assets: [],
  jobs: new Map(),   // jobId -> JobState
  jobEls: new Map(), // jobId -> {root, ...refs}
  es: null,
};

/* ---------------- helpers ---------------- */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error("Cannot reach the epic-fab backend.");
  }
  if (res.status === 401) {
    showAuth();
    const err = new Error("Session expired. Sign in again.");
    err.auth = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
  return data;
}

function fmtBytes(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(n) / 10));
  const v = n / Math.pow(2, 10 * i);
  return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + " " + units[i];
}

function monogramFor(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (h * 31 + title.charCodeAt(i)) | 0;
  }
  const hue = ((h % 360) + 360) % 360;
  const words = title.trim().split(/\s+/).filter(Boolean);
  const first = words.length ? words[0].charAt(0) : "?";
  const second = words.length > 1 ? words[1].charAt(0) : "";
  return { hue, letters: (first + second).toUpperCase() };
}

function monogramEl(title) {
  const { hue, letters } = monogramFor(title);
  const m = el("div", "monogram", letters);
  m.style.background =
    "linear-gradient(135deg, hsl(" + hue + " 42% 30%), hsl(" + ((hue + 42) % 360) + " 48% 13%))";
  return m;
}

function toast(msg, kind) {
  const t = el("div", "toast" + (kind ? " toast-" + kind : ""), msg);
  $("#toasts").append(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  }, 4200);
}

/* ---------------- views ---------------- */

function show(view) {
  $("#view-auth").hidden = view !== "auth";
  $("#view-main").hidden = view !== "main";
}

function showAuth() {
  state.user = null;
  if (state.es) { state.es.close(); state.es = null; }
  $("#auth-code").value = "";
  $("#auth-error").hidden = true;
  show("auth");
}

function showMain(user) {
  state.user = user || null;
  $("#hdr-user").textContent = state.user && state.user.displayName ? state.user.displayName : "";
  show("main");
}

function authError(msg) {
  const e = $("#auth-error");
  e.textContent = msg;
  e.hidden = false;
}

/* ---------------- auth flow ---------------- */

function bindAuth() {
  $("#auth-signin").addEventListener("click", async () => {
    const btn = $("#auth-signin");
    btn.disabled = true;
    $("#auth-error").hidden = true;
    try {
      const data = await api("/api/auth/url");
      window.open(data.url, "_blank", "noopener");
      $("#auth-code").focus();
    } catch (err) {
      authError(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  const submit = async () => {
    const input = $("#auth-code");
    const code = input.value.trim();
    if (!code) { authError("Paste the code first."); return; }
    const btn = $("#auth-submit");
    btn.disabled = true;
    $("#auth-error").hidden = true;
    try {
      const data = await api("/api/auth", { method: "POST", body: { code } });
      enterApp({ displayName: data.displayName });
    } catch (err) {
      if (!err.auth) authError(err.message);
    } finally {
      btn.disabled = false;
    }
  };

  $("#auth-submit").addEventListener("click", submit);
  $("#auth-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

/* ---------------- header ---------------- */

function bindHeader() {
  $("#hdr-logout").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch { /* session already gone */ }
    showAuth();
  });

  $("#btn-downloads").addEventListener("click", () => setDrawer(true));
  $("#drawer-close").addEventListener("click", () => setDrawer(false));
  $("#drawer-scrim").addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setDrawer(false);
  });

  $("#drawer-clear").addEventListener("click", () => {
    for (const [id, job] of state.jobs) {
      if (job.status === "done" || job.status === "error") {
        state.jobs.delete(id);
        const refs = state.jobEls.get(id);
        if (refs) { refs.root.remove(); state.jobEls.delete(id); }
      }
    }
    updateJobsUi();
  });

  $("#search-input").addEventListener("input", renderGrid);

  $("#btn-refresh").addEventListener("click", async () => {
    const btn = $("#btn-refresh");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await loadLibrary(true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh";
    }
  });
}

function setDrawer(open) {
  $("#drawer").classList.toggle("open", open);
  $("#drawer-scrim").hidden = !open;
  $("#btn-downloads").setAttribute("aria-expanded", String(open));
}

/* ---------------- library ---------------- */

async function loadLibrary(refresh) {
  $("#grid-skeleton").hidden = false;
  $("#grid").replaceChildren();
  $("#grid-empty").hidden = true;
  try {
    const data = await api(refresh ? "/api/library?refresh=1" : "/api/library");
    state.assets = Array.isArray(data.assets) ? data.assets : [];
    renderGrid();
  } catch (err) {
    if (!err.auth) toast(err.message, "error");
  } finally {
    $("#grid-skeleton").hidden = true;
  }
}

function renderGrid() {
  const q = $("#search-input").value.trim().toLowerCase();
  const list = q
    ? state.assets.filter((a) => (a.title || "").toLowerCase().includes(q))
    : state.assets;

  $("#grid").replaceChildren(...list.map(assetCard));

  const empty = $("#grid-empty");
  if (list.length === 0) {
    empty.textContent = q
      ? "Nothing matches that filter."
      : "Library is empty. Assets you own on Fab.com will show up here.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

function extIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "ext-icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6.5 3.5h6v6M12.5 3.5L7 9M10 12.5H4.5a1 1 0 0 1-1-1V6");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  const wrap = el("span", "card-ext");
  wrap.append(svg);
  return wrap;
}

function assetCard(asset) {
  const title = asset.title || "Untitled asset";
  const card = el("article", "card");
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  card.setAttribute("aria-label", "View on Fab: " + title);
  card.title = "View on Fab";

  const thumb = el("div", "thumb");
  thumb.append(el("span", "badge", asset.type || "asset"));

  if (asset.thumbnail) {
    const img = new Image();
    img.className = "thumb-img";
    img.src = asset.thumbnail;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.remove();
      thumb.prepend(monogramEl(title));
    });
    thumb.append(img);
  } else {
    thumb.append(monogramEl(title));
  }

  thumb.append(extIcon());

  const dl = el("button", "card-dl", "Download");
  dl.setAttribute("aria-label", "Download " + title);
  dl.addEventListener("click", (e) => {
    e.stopPropagation();
    downloadAsset(asset);
  });
  thumb.append(dl);

  const body = el("div", "card-body");
  body.append(el("h3", "card-title", title));
  card.append(thumb, body);

  const openFab = () => {
    if (asset.fabUrl) window.open(asset.fabUrl, "_blank", "noopener");
  };
  card.addEventListener("click", openFab);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFab();
    }
  });
  return card;
}

async function downloadAsset(asset) {
  try {
    await api("/api/download", { method: "POST", body: { assetId: asset.id } });
    toast("Queued: " + (asset.title || asset.id), "success");
    setDrawer(true);
  } catch (err) {
    if (!err.auth) toast(err.message, "error");
  }
}

/* ---------------- downloads / jobs ---------------- */

async function seedJobs() {
  try {
    const data = await api("/api/jobs");
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    for (const job of jobs) upsertJob(job);
  } catch { /* SSE will still deliver live state */ }
}

function connectEvents() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let parsed;
    try {
      parsed = JSON.parse(e.data);
    } catch { return; } /* ignore malformed event */

    if (parsed && Array.isArray(parsed.jobs)) {
      for (const job of parsed.jobs) upsertJob(job);
    } else if (parsed && typeof parsed.jobId === "string") {
      upsertJob(parsed);
    }
    /* anything else is ignored defensively */
  };
  state.es = es;
}

function jobPct(job) {
  if (job.bytesTotal > 0) return job.bytesDone / job.bytesTotal;
  if (job.fileTotal > 0) return job.filesDone / job.fileTotal;
  return null;
}

function buildJobEl(job) {
  const root = el("div", "job");
  const top = el("div", "job-top");
  const title = el("span", "job-title");
  const status = el("span", "job-status");
  top.append(title, status);
  const bar = el("div", "bar");
  const fill = el("div", "bar-fill");
  bar.append(fill);
  const meta = el("div", "job-meta");
  const file = el("div", "job-file");
  const errLine = el("div", "job-err");

  const cancel = el("button", "btn btn-ghost btn-sm job-cancel", "Cancel");
  cancel.setAttribute("aria-label", "Cancel download");
  cancel.addEventListener("click", () => cancelJob(job.jobId, cancel));

  root.append(top, bar, meta, file, errLine, cancel);
  return { root, title, status, bar, fill, meta, file, errLine, cancel };
}

async function cancelJob(jobId, btn) {
  btn.disabled = true;
  try {
    await api("/api/download/" + encodeURIComponent(jobId) + "/cancel", { method: "POST" });
    /* SSE "cancelled" update re-renders the card */
  } catch (err) {
    if (!err.auth) toast(err.message, "error");
    btn.disabled = false;
  }
}

function paintJob(refs, job) {
  refs.root.dataset.status = job.status;
  refs.title.textContent = job.title || job.assetId;
  refs.title.title = job.title || job.assetId;

  const labels = {
    resolving: "Resolving",
    downloading: "Downloading",
    done: "Done",
    error: "Failed",
    cancelled: "Cancelled",
  };
  refs.status.textContent = labels[job.status] || job.status;

  const pct = jobPct(job);
  const indeterminate = job.status === "resolving" || (job.status === "downloading" && pct === null);
  refs.bar.classList.toggle("indeterminate", indeterminate);
  refs.fill.style.width = pct === null ? "0%" : Math.min(100, Math.round(pct * 100)) + "%";

  if (job.status === "done") {
    refs.meta.textContent =
      job.filesDone + " files · " + fmtBytes(job.bytesDone) + " · " + job.targetDir;
  } else if (job.status === "error") {
    refs.meta.textContent = job.filesDone + "/" + job.fileTotal + " files before failure";
  } else if (job.status === "cancelled") {
    refs.meta.textContent = "Stopped · " + job.filesDone + " files · " + job.targetDir;
  } else {
    const pctTxt = pct === null ? "—" : Math.round(pct * 100) + "%";
    refs.meta.textContent =
      pctTxt + " · " + fmtBytes(job.bytesDone) + " / " + fmtBytes(job.bytesTotal) +
      " · " + job.filesDone + "/" + job.fileTotal + " files";
  }

  if (job.status === "downloading" && job.currentFile) {
    refs.file.textContent = job.currentFile;
    refs.file.hidden = false;
  } else {
    refs.file.hidden = true;
  }

  if (job.status === "error") {
    refs.errLine.replaceChildren(
      document.createTextNode(job.error || "Download failed. "),
      (() => {
        const t = el("span", "job-target", "target: " + job.targetDir);
        return t;
      })()
    );
    refs.errLine.hidden = false;
  } else {
    refs.errLine.hidden = true;
  }

  const cancelable = job.status === "resolving" || job.status === "downloading";
  refs.cancel.hidden = !cancelable;
  if (cancelable) refs.cancel.disabled = false;
}

function upsertJob(job) {
  if (!job || typeof job.jobId !== "string") return;
  state.jobs.set(job.jobId, job);
  let refs = state.jobEls.get(job.jobId);
  if (!refs) {
    refs = buildJobEl(job);
    state.jobEls.set(job.jobId, refs);
    $("#jobs-list").prepend(refs.root);
  }
  paintJob(refs, job);
  updateJobsUi();
}

function updateJobsUi() {
  $("#jobs-empty").hidden = state.jobs.size > 0;
  let active = 0;
  for (const job of state.jobs.values()) {
    if (job.status === "resolving" || job.status === "downloading") active++;
  }
  const badge = $("#dl-count");
  badge.hidden = active === 0;
  badge.textContent = String(active);
}

/* ---------------- boot ---------------- */

function enterApp(user) {
  showMain(user);
  loadLibrary();
  seedJobs();
  connectEvents();
}

async function init() {
  bindAuth();
  bindHeader();
  try {
    const s = await api("/api/status");
    if (s.authenticated) enterApp(s.user);
    else showAuth();
  } catch (err) {
    if (!err.auth) {
      showAuth();
      toast(err.message, "error");
    }
  }
}

init();
