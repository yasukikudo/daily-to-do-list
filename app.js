import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword,
  setPersistence, browserSessionPersistence, browserLocalPersistence }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, setDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, PIN_LENGTH, ASK_PIN_EVERY_TIME, STICKERS } from "./config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
const persistenceReady = setPersistence(auth, ASK_PIN_EVERY_TIME ? browserSessionPersistence : browserLocalPersistence);

// Two columns. Each person's name, column and routines live in their own Firestore document
// (profiles/{uid}), which only that person can change (enforced by the Firestore rules).
const PEOPLE = ["pa", "pb"];
const EMPTY_SETTINGS = { names: { pa: "", pb: "" }, recurring: { pa: [], pb: [] }, members: {} };

// Tap order for the status stamp
const STATUS = [
  { key: "", label: "Not marked", emoji: "" },
  { key: "done", label: "Done", emoji: "✅" },
  { key: "missed", label: "Not done", emoji: "❌" },
  { key: "carry", label: "Carry over", emoji: "🆙" },
  { key: "partial", label: "Done, continue tomorrow", emoji: "✅🆙" },
  { key: "missedcarry", label: "Not done, carry over", emoji: "❌🆙" }
];
const statusOf = k => STATUS.find(s => s.key === (k || "")) || STATUS[0];
const isDone = t => t.status === "done" || t.status === "partial";
const CARRY = ["carry", "partial", "missedcarry"];
// A picked stamp (💕 etc.) replaces ✅ and counts as done
const stampOf = t => (t.status === "done" && t.emoji) ? t.emoji : statusOf(t.status).emoji;

// The email is typed once per device and kept only in this browser
function savedEmail() { try { return localStorage.getItem("email") || ""; } catch (_) { return ""; } }
function saveEmail(v) { try { v ? localStorage.setItem("email", v) : localStorage.removeItem("email"); } catch (_) {} }

const state = {
  user: undefined, days: {}, settings: EMPTY_SETTINGS, settingsLoaded: false, date: todayStr(),
  profiles: {}, legacy: null, profilesLoaded: false, legacyLoaded: false, migrated: false,
  readOnly: false, openNotes: {}, openPicker: null, popId: null, banner: "",
  pendingEmail: "", pin: "", pinErr: "", busy: false,
  calMonth: todayStr().slice(0, 7), calOpen: false
};
let unsubs = [];

/* ---------- dates ---------- */
function pad(n) { return String(n).padStart(2, "0"); }
function fmt(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function todayStr() { return fmt(new Date()); }
function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); }
function weekOf(s) {
  const d = parse(s); const shift = (d.getDay() + 6) % 7; // week starts Monday
  const mon = addDays(s, -shift);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

function setDate(d) { state.date = d; state.calMonth = d.slice(0, 7); state.calOpen = false; }
function shiftMonth(ym, n) { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }

/* ---------- helpers ---------- */
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function uid() { return Math.random().toString(36).slice(2, 10); }
function newTask(text) { return { id: uid(), text, status: "", note: "" }; }
function dayId(person, date) { return date + "_" + person; }
function getDay(person, date) { return state.days[dayId(person, date)]; }
function nameOf(p) { return state.settings.names[p] || (p === "pa" ? "Left" : "Right"); }
function mySlot() { return state.user ? state.settings.members[state.user.uid] : undefined; }
function ownerOf(p) { return Object.keys(state.settings.members).find(u => state.settings.members[u] === p); }
function myProfile() { return state.user ? state.profiles[state.user.uid] : undefined; }
// Combine everyone's profile into one view (the old shared settings/main is only a fallback)
function rebuild() {
  const out = { names: { pa: "", pb: "" }, recurring: { pa: [], pb: [] }, members: {} };
  const claimed = new Set(Object.values(state.profiles).map(p => p.slot));
  const L = state.legacy;
  if (L) PEOPLE.forEach(p => {
    if (claimed.has(p)) return;
    if (L.names && L.names[p]) out.names[p] = L.names[p];
    if (L.recurring && L.recurring[p]) out.recurring[p] = L.recurring[p];
    Object.entries(L.members || {}).forEach(([u, sl]) => { if (sl === p && !state.profiles[u]) out.members[u] = p; });
  });
  Object.entries(state.profiles).forEach(([u, p]) => {
    if (!PEOPLE.includes(p.slot)) return;
    out.members[u] = p.slot;
    out.names[p.slot] = p.name || "";
    out.recurring[p.slot] = Array.isArray(p.recurring) ? p.recurring : [];
  });
  state.settings = out;
  state.settingsLoaded = state.profilesLoaded && state.legacyLoaded;
  // one-time move of this person's entry from the old shared settings into their own profile
  if (state.settingsLoaded && !state.migrated && !myProfile() && L && L.members && L.members[state.user.uid]) {
    state.migrated = true;
    const slot = L.members[state.user.uid];
    saveProfile({ slot, name: (L.names && L.names[slot]) || "", recurring: (L.recurring && L.recurring[slot]) || [] });
  }
}

/* ---------- saving (one write at a time per document) ---------- */
const pending = {}, inflight = {};
function persist(path, data) {
  pending[path] = data;
  if (!inflight[path]) flush(path);
}
async function flush(path) {
  inflight[path] = true;
  while (pending[path]) {
    const data = pending[path]; delete pending[path];
    try { await setDoc(doc(db, path), data); }
    catch (e) {
      if (e.code === "permission-denied") { state.readOnly = true; state.banner = "This account is not allowed to edit the list."; }
      else state.banner = "Could not save the last change. Check your connection and try again.";
      render(); break;
    }
  }
  inflight[path] = false;
}
function saveProfile(p) {
  const path = "profiles/" + state.user.uid;
  state.profiles = { ...state.profiles, [state.user.uid]: p };
  rebuild(); render();
  persist(path, p);
}

function mutate(person, date, fn) {
  if (state.readOnly || person !== mySlot()) return; // you can only change your own list
  const existing = getDay(person, date);
  const d = existing ? structuredClone(existing)
    : { date, person, comment: "", tasks: (state.settings.recurring[person] || []).map(newTask) };
  fn(d);
  d.updatedAt = new Date().toISOString();
  const id = dayId(person, date);
  state.days[id] = d;
  render();
  persist("days/" + id, d);
}

/* ---------- rendering ---------- */
const app = document.getElementById("app");

function render() {
  if (state.user === undefined) { app.innerHTML = ""; return; }
  if (!state.user) { renderLogin(); return; }
  if (!state.settingsLoaded) { app.innerHTML = ""; return; }
  if (!mySlot() && !state.readOnly) { renderJoin(); return; }
  // keep whatever the person is typing when a live update arrives
  const a = document.activeElement;
  const keep = a && a.dataset && a.dataset.key && app.contains(a)
    ? { key: a.dataset.key, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;

  app.innerHTML = `<div class="layout"><aside class="side" aria-label="Calendar">${calHTML()}</aside><div class="main">` +
    headerHTML() + weekHTML() +
    (state.banner ? `<div class="banner" role="status">${esc(state.banner)}</div>` : "") +
    '<div class="cols">' + PEOPLE.map(columnHTML).join("") + "</div>" + legendHTML() + "</div></div>";

  if (keep) {
    const el = app.querySelector('[data-key="' + CSS.escape(keep.key) + '"]');
    if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (_) {} }
  }
  if (state.popId) {
    const s = app.querySelector('[data-stamp="' + state.popId + '"]');
    if (s) s.classList.add("pop");
    state.popId = null;
  }
}

/* sign in: email once per device, then PIN */
function renderLogin() {
  const email = savedEmail() || state.pendingEmail;
  if (!email) {
    app.innerHTML = `<div class="login"><form class="card" id="emailForm">
      <h1>Our Daily List</h1>
      <p>First time on this device. Enter your email.</p>
      <input class="emailin" id="emailIn" type="email" autocomplete="username" required aria-label="Email">
      <button class="pill primary nextbtn" type="submit">Next</button>
    </form></div>`;
    document.getElementById("emailForm").addEventListener("submit", e => {
      e.preventDefault();
      state.pendingEmail = document.getElementById("emailIn").value.trim().toLowerCase();
      state.pin = ""; state.pinErr = ""; renderLogin();
    });
    document.getElementById("emailIn").focus();
    return;
  }
  const dots = Array.from({ length: PIN_LENGTH }, (_, i) => `<i class="${i < state.pin.length ? "on" : ""}"></i>`).join("");
  const keys = ["1","2","3","4","5","6","7","8","9","","0","del"].map(k =>
    k === "" ? '<span class="key blank"></span>'
    : k === "del" ? '<button class="key" data-del aria-label="Delete">⌫</button>'
    : `<button class="key" data-digit="${k}">${k}</button>`).join("");
  app.innerHTML = `<div class="login"><div class="card">
    <h1>Our Daily List</h1>
    <p>Enter your PIN</p>
    <div class="dots ${state.pinErr ? "shake" : ""}" aria-label="${state.pin.length} of ${PIN_LENGTH} digits entered">${dots}</div>
    <div class="err" role="alert">${esc(state.pinErr)}</div>
    <div class="pad">${keys}</div>
    <button class="linkbtn" data-reset-email>Use a different email</button>
  </div></div>`;
}

function pressDigit(d) {
  if (state.busy || state.pin.length >= PIN_LENGTH) return;
  state.pin += d; state.pinErr = "";
  renderLogin();
  if (state.pin.length === PIN_LENGTH) tryLogin();
}
async function tryLogin() {
  state.busy = true;
  try {
    await persistenceReady;
    await signInWithEmailAndPassword(auth, savedEmail() || state.pendingEmail, state.pin);
    if (!savedEmail()) saveEmail(state.pendingEmail);
    state.pendingEmail = "";
  } catch (e) {
    state.pinErr = e.code === "auth/too-many-requests" ? "Too many tries. Wait a few minutes and try again."
      : (savedEmail() ? "That PIN did not work." : "The email or PIN did not match.");
    state.pin = "";
    renderLogin();
  } finally { state.busy = false; }
}

/* first sign-in: each person registers their name and picks a column */
function renderJoin() {
  const opts = PEOPLE.map(p => {
    const owner = ownerOf(p);
    const taken = owner && owner !== state.user.uid;
    return `<button type="button" class="slot ${p} ${state.joinSlot === p ? "on" : ""}" data-slot="${p}" ${taken ? "disabled" : ""}>
      ${taken ? esc(nameOf(p)) + " (taken)" : (p === "pa" ? "Left column" : "Right column")}</button>`;
  }).join("");
  const full = PEOPLE.every(p => ownerOf(p) && ownerOf(p) !== state.user.uid);
  app.innerHTML = `<div class="login"><form class="card" id="joinForm">
    <h1>Welcome</h1>
    ${full ? `<p>This list already has two people.</p>`
      : `<p>Set up your side of the list. You can change this later with ⚙.</p>
    <input class="emailin" id="joinName" placeholder="Your name" required aria-label="Your name" maxlength="30">
    <div class="slots">${opts}</div>
    <button class="pill primary nextbtn" type="submit">Start</button>`}
  </form></div>`;
  if (full) return;
  const f = document.getElementById("joinForm");
  f.addEventListener("click", e => {
    const b = e.target.closest("[data-slot]"); if (!b) return;
    const v = document.getElementById("joinName").value;
    state.joinSlot = b.dataset.slot; renderJoin();
    document.getElementById("joinName").value = v;
  });
  f.addEventListener("submit", e => {
    e.preventDefault();
    const name = document.getElementById("joinName").value.trim();
    const slot = state.joinSlot || PEOPLE.find(p => !ownerOf(p));
    if (!name || !slot) return;
    state.joinSlot = null;
    saveProfile({ slot, name, recurring: [] });
  });
}

function headerHTML() {
  const d = parse(state.date), t = todayStr();
  const rel = state.date === t ? "Today" : state.date === addDays(t, 1) ? "Tomorrow" : state.date === addDays(t, -1) ? "Yesterday" : "";
  return `<header class="top">
    <div class="date">
      <button class="datebtn" data-action="cal" aria-label="Open calendar" aria-expanded="${state.calOpen}">
        <span class="daynum">${d.getDate()}</span>
        <span class="dateinfo"><span class="rel">${rel}</span>
          <span class="weekday">${d.toLocaleDateString("en-US", { weekday: "long" })}</span>
          <span class="month">${d.toLocaleDateString("en-US", { month: "long", year: "numeric" })} <span class="chev" aria-hidden="true">▾</span></span></span>
      </button>
      ${state.calOpen ? `<div class="calpop">${calHTML()}</div>` : ""}
    </div>
    <div class="controls">
      <button class="iconbtn" data-action="prev" aria-label="Previous day">‹</button>
      <button class="pill" data-action="today">Today</button>
      <button class="pill" data-action="tomorrow">Plan tomorrow</button>
      <button class="iconbtn" data-action="next" aria-label="Next day">›</button>
      <button class="iconbtn" data-action="settings" aria-label="My settings, PIN and sign out">⚙</button>
    </div>
  </header>`;
}

function ratio(person, date) {
  const d = getDay(person, date);
  if (!d || !d.tasks.length) return 0;
  return d.tasks.filter(isDone).length / d.tasks.length;
}

function calHTML() {
  const [y, m] = state.calMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const count = new Date(y, m, 0).getDate();
  const t = todayStr();
  let cells = "";
  for (let i = 0; i < lead; i++) cells += "<span></span>";
  for (let n = 1; n <= count; n++) {
    const ds = state.calMonth + "-" + pad(n);
    const dots = PEOPLE.map(p => {
      const d = getDay(p, ds);
      if (!d || !d.tasks.length) return '<i class="none"></i>';
      return `<i class="${p}" style="opacity:${Math.max(0.3, ratio(p, ds)).toFixed(2)}"></i>`;
    }).join("");
    cells += `<button class="cd ${ds === state.date ? "sel" : ""} ${ds === t ? "today" : ""}" data-date="${ds}"
      aria-label="${parse(ds).toDateString()}"><span>${n}</span><span class="cdots">${dots}</span></button>`;
  }
  return `<div class="cal">
    <div class="calhead">
      <button class="calnav" data-action="calprev" aria-label="Previous month">‹</button>
      <span>${first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
      <button class="calnav" data-action="calnext" aria-label="Next month">›</button>
    </div>
    <div class="calgrid">${["M","T","W","T","F","S","S"].map(x => `<span class="cw">${x}</span>`).join("")}${cells}</div>
    <button class="linkbtn caltoday" data-action="today">Back to today</button>
  </div>`;
}

function weekHTML() {
  const t = todayStr();
  return '<nav class="week" aria-label="This week">' + weekOf(state.date).map(ds => {
    const d = parse(ds);
    const a = Math.round(ratio("pa", ds) * 100), b = Math.round(ratio("pb", ds) * 100);
    return `<button class="wd ${ds === state.date ? "sel" : ""} ${ds === t ? "today" : ""}" data-date="${ds}"
      aria-label="${d.toDateString()}, ${esc(nameOf("pa"))} ${a}% done, ${esc(nameOf("pb"))} ${b}% done">
      <span class="l">${d.toLocaleDateString("en-US", { weekday: "short" })}</span>
      <span class="n">${d.getDate()}</span>
      <span class="bars"><span class="bar pa"><i style="height:${a}%"></i></span><span class="bar pb"><i style="height:${b}%"></i></span></span>
    </button>`;
  }).join("") + "</nav>";
}

function carryCandidates(person) {
  const prev = getDay(person, addDays(state.date, -1));
  if (!prev) return [];
  const cur = getDay(person, state.date);
  const have = new Set((cur ? cur.tasks : []).map(t => t.text.trim().toLowerCase()));
  return prev.tasks.filter(t => CARRY.includes(t.status) && !have.has(t.text.trim().toLowerCase()));
}

// Routines not yet in this person's list for the shown day
function missingRoutines(person) {
  const cur = getDay(person, state.date);
  const have = new Set((cur ? cur.tasks : []).map(t => t.text.trim().toLowerCase()));
  return (state.settings.recurring[person] || []).filter(r => !have.has(r.trim().toLowerCase()));
}

function columnHTML(person) {
  const name = nameOf(person);
  const day = getDay(person, state.date);
  const tasks = day ? day.tasks : [];
  const done = tasks.filter(isDone).length;
  const carry = carryCandidates(person);
  const mine = mySlot() === person;
  // routine controls only in your own column
  const missing = mine ? missingRoutines(person) : [];
  const edit = mine && !state.readOnly; // the other person's column is view-only
  const ro = edit ? "" : "disabled";
  const routines = state.settings.recurring[person] || [];

  const list = tasks.length ? '<ul class="tasks">' + tasks.map(t => {
    const st = statusOf(t.status);
    const showNote = t.note || (edit && state.openNotes[t.id]);
    return `<li class="task ${isDone(t) ? "done" : ""}">
      <button class="stamp ${st.key ? "set" : ""}" data-action="status" data-person="${person}" data-id="${t.id}" data-stamp="${t.id}"
        aria-label="Status: ${st.label}. Tap to change." title="${st.label}" ${ro}>${stampOf(t)}</button>
      <div class="body">
        <input class="text" data-field="text" data-person="${person}" data-id="${t.id}" data-key="text-${t.id}" value="${esc(t.text)}" aria-label="Task" ${ro}>
        ${edit && state.openPicker === t.id ? `<div class="picker" role="group" aria-label="Pick a stamp">${STICKERS.map(em =>
          `<button data-action="sticker" data-person="${person}" data-id="${t.id}" data-emoji="${em}" aria-label="Stamp ${em}">${em}</button>`).join("")}</div>` : ""}
        ${showNote ? `<input class="note" data-field="note" data-person="${person}" data-id="${t.id}" data-key="note-${t.id}" value="${esc(t.note)}" placeholder="Add a note" aria-label="Note" ${ro}>` : ""}
      </div>
      ${edit ? `<div class="tools">
        <button class="tool" data-action="picker" data-id="${t.id}" aria-label="Pick a stamp" title="Pick a stamp" ${ro}>♡</button>
        ${showNote ? "" : `<button class="tool" data-action="note" data-id="${t.id}" aria-label="Add note" title="Add note" ${ro}>✎</button>`}
        <button class="tool" data-action="delete" data-person="${person}" data-id="${t.id}" aria-label="Delete task" title="Delete">✕</button>
      </div>` : ""}
    </li>`;
  }).join("") + "</ul>"
    : `<div class="empty">Nothing planned yet.${mine && routines.length ? " Adding a task starts the day with these routines:" : ""}</div>
       ${mine && routines.length ? `<ul class="ghost">${routines.map(r => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
       ${mine ? `<button class="linkbtn routinebtn" data-action="settings">${routines.length ? "Edit daily routines" : "Set daily routines"}</button>` : ""}`;

  return `<section class="col ${person}" aria-label="${esc(name)}">
    <div class="colhead"><span class="name">${esc(name)}</span><span class="count">${tasks.length ? done + " of " + tasks.length + " done" : ""}</span></div>
    ${edit || (day && day.comment) ? `<input class="comment" data-field="comment" data-person="${person}" data-key="comment-${person}" value="${esc(day ? day.comment : "")}" placeholder="A line about the day" aria-label="Comment for the day" ${ro}>` : '<div class="comment-gap"></div>'}
    ${list}
    ${edit ? `<div class="add"><span aria-hidden="true">+</span><input data-add="${person}" data-key="add-${person}" placeholder="Add a task" aria-label="Add a task for ${esc(name)}"></div>` : ""}
    ${missing.length && edit ? `<button class="carry" data-action="routines" data-person="${person}">Add ${missing.length} daily routine${missing.length > 1 ? "s" : ""}</button>` : ""}
    ${carry.length && edit ? `<button class="carry" data-action="carry" data-person="${person}">Bring over ${carry.length} unfinished from yesterday 🆙</button>` : ""}
  </section>`;
}

function legendHTML() {
  return '<div class="legend">' + STATUS.slice(1).map(s => `<span>${s.emoji} ${s.label}</span>`).join("") + "<span>♡ Pick a stamp</span></div>";
}

/* ---------- events ---------- */
app.addEventListener("click", e => {
  if (!state.user) {
    const dg = e.target.closest("[data-digit]");
    if (dg) pressDigit(dg.dataset.digit);
    else if (e.target.closest("[data-del]")) { state.pin = state.pin.slice(0, -1); state.pinErr = ""; renderLogin(); }
    else if (e.target.closest("[data-reset-email]")) { saveEmail(""); state.pendingEmail = ""; state.pin = ""; state.pinErr = ""; renderLogin(); }
    return;
  }
  const wd = e.target.closest("[data-date]");
  if (wd) { setDate(wd.dataset.date); render(); return; }
  const b = e.target.closest("[data-action]");
  const inCal = e.target.closest(".cal");
  if (state.calOpen && !inCal && !(b && b.dataset.action === "cal")) { state.calOpen = false; if (!b) { render(); return; } }
  if (!b) return;
  const { action, person, id } = b.dataset;
  if (action === "cal") { if (!matchMedia("(max-width: 899px)").matches) return; state.calOpen = !state.calOpen; state.calMonth = state.date.slice(0, 7); render(); return; }
  if (action === "calprev" || action === "calnext") { state.calMonth = shiftMonth(state.calMonth, action === "calprev" ? -1 : 1); render(); return; }
  if (action === "prev") setDate(addDays(state.date, -1));
  else if (action === "next") setDate(addDays(state.date, 1));
  else if (action === "today") setDate(todayStr());
  else if (action === "tomorrow") setDate(addDays(todayStr(), 1));
  else if (action === "settings") { openSettings(); return; }
  else if (action === "status") {
    state.popId = id;
    mutate(person, state.date, d => {
      const t = d.tasks.find(x => x.id === id); if (!t) return;
      const i = STATUS.findIndex(s => s.key === (t.status || ""));
      t.status = STATUS[(i + 1) % STATUS.length].key;
      delete t.emoji;
    });
    return;
  }
  else if (action === "picker") { state.openPicker = state.openPicker === id ? null : id; render(); return; }
  else if (action === "sticker") {
    state.popId = id; state.openPicker = null;
    mutate(person, state.date, d => { const t = d.tasks.find(x => x.id === id); if (t) { t.status = "done"; t.emoji = b.dataset.emoji; } });
    return;
  }
  else if (action === "delete") { mutate(person, state.date, d => { d.tasks = d.tasks.filter(x => x.id !== id); }); return; }
  else if (action === "note") {
    state.openNotes[id] = true; render();
    const n = app.querySelector('[data-key="note-' + id + '"]'); if (n) n.focus();
    return;
  }
  else if (action === "routines") {
    if (person !== mySlot()) return;
    mutate(person, state.date, d => {
      const have = new Set(d.tasks.map(t => t.text.trim().toLowerCase()));
      const add = (state.settings.recurring[person] || []).filter(r => !have.has(r.trim().toLowerCase())).map(newTask);
      d.tasks = add.concat(d.tasks); // routines go to the top, like on a fresh day
    });
    return;
  }
  else if (action === "carry") {
    const items = carryCandidates(person);
    mutate(person, state.date, d => { items.forEach(t => d.tasks.push(newTask(t.text))); });
    return;
  }
  render();
});

app.addEventListener("keydown", e => {
  const el = e.target;
  if (e.key !== "Enter" || e.isComposing) return; // isComposing: ignore Enter while typing Japanese
  if (el.dataset.add) {
    const text = el.value.trim(); if (!text) return;
    el.value = "";
    mutate(el.dataset.add, state.date, d => { d.tasks.push(newTask(text)); });
    return;
  }
  if (el.dataset.field) el.blur();
});

app.addEventListener("change", e => {
  const el = e.target, f = el.dataset.field;
  if (!f) return;
  const { person, id } = el.dataset, v = el.value.trim();
  const day = getDay(person, state.date);
  if (f === "comment") {
    if ((day ? day.comment : "") === v) return;
    mutate(person, state.date, d => { d.comment = v; });
    return;
  }
  const t = day && day.tasks.find(x => x.id === id);
  if (!t || (t[f] || "") === v) return;
  if (f === "text" && !v) { mutate(person, state.date, d => { d.tasks = d.tasks.filter(x => x.id !== id); }); return; }
  mutate(person, state.date, d => { const x = d.tasks.find(y => y.id === id); if (x) x[f] = v; });
});

document.addEventListener("keydown", e => {
  if (!state.user && (savedEmail() || state.pendingEmail) && !(e.target instanceof HTMLInputElement)) {
    if (/^[0-9]$/.test(e.key)) pressDigit(e.key);
    else if (e.key === "Backspace") { state.pin = state.pin.slice(0, -1); renderLogin(); }
    return;
  }
  if (!state.user || !(e.target instanceof Element) || e.target.closest("input, textarea, dialog")) return;
  if (e.key === "Escape" && state.calOpen) { state.calOpen = false; render(); }
  if (e.key === "ArrowLeft") { setDate(addDays(state.date, -1)); render(); }
  if (e.key === "ArrowRight") { setDate(addDays(state.date, 1)); render(); }
});

/* ---------- settings ---------- */
const dlg = document.getElementById("settings");
function openSettings() {
  const me = mySlot();
  dlg.innerHTML = `<form class="dlg" method="dialog">
    <h2>My settings</h2>
    ${me ? `<p>Only you can change these. Daily routines are added to a new day automatically when its first task is added. Write one per line.</p>
    <div class="mine">
      <label for="myName">My name</label><input id="myName" value="${esc(state.settings.names[me])}" maxlength="30">
      <label for="myRoutines" style="margin-top:12px">My daily routines</label><textarea id="myRoutines">${esc((state.settings.recurring[me] || []).join("\n"))}</textarea>
    </div>` : ""}
    <div class="pinset">
      <h3>Change my PIN</h3>
      <div class="pinrow">
        <input id="pin1" type="password" inputmode="numeric" autocomplete="new-password" maxlength="${PIN_LENGTH}" placeholder="New PIN" aria-label="New PIN">
        <input id="pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="${PIN_LENGTH}" placeholder="Again" aria-label="Repeat new PIN">
        <button class="pill" value="pin">Change</button>
      </div>
    </div>
    <div class="dlgbtns">
      <button class="pill signout" value="signout">Sign out</button>
      <button class="pill" value="cancel">Cancel</button>
      <button class="pill primary" value="save" ${state.readOnly ? "disabled" : ""}>Save</button>
    </div>
  </form>`;
  dlg.showModal();
}
dlg.addEventListener("close", () => {
  if (dlg.returnValue === "signout") { signOut(auth); return; }
  if (dlg.returnValue === "pin") { changePin(dlg.querySelector("#pin1").value, dlg.querySelector("#pin2").value); return; }
  if (dlg.returnValue !== "save") return;
  const me = mySlot(); if (!me) return;
  saveProfile({
    slot: me,
    name: dlg.querySelector("#myName").value.trim(),
    recurring: dlg.querySelector("#myRoutines").value.split("\n").map(x => x.trim()).filter(Boolean)
  });
});

async function changePin(a, b) {
  const re = new RegExp("^[0-9]{" + PIN_LENGTH + "}$");
  if (!re.test(a)) state.banner = "The new PIN must be " + PIN_LENGTH + " digits.";
  else if (a !== b) state.banner = "The two PINs did not match. Nothing was changed.";
  else {
    try { await updatePassword(auth.currentUser, a); state.banner = "PIN changed."; }
    catch (e) {
      state.banner = e.code === "auth/requires-recent-login"
        ? "For safety, sign out and sign in again, then change the PIN."
        : "Could not change the PIN. Try again.";
    }
  }
  render();
  setTimeout(() => { if (state.banner === "PIN changed.") { state.banner = ""; render(); } }, 3000);
}

/* ---------- start ---------- */
onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = [];
  Object.assign(state, { user, days: {}, settings: EMPTY_SETTINGS, settingsLoaded: false, readOnly: false, banner: "", pin: "", pinErr: "",
    profiles: {}, legacy: null, profilesLoaded: false, legacyLoaded: false, migrated: false });
  render();
  if (!user) return;
  unsubs.push(onSnapshot(collection(db, "days"), snap => {
    const next = {};
    snap.forEach(s => { next[s.id] = s.data(); });
    // keep local copies of documents that are still being saved
    Object.keys(state.days).forEach(id => { if (pending["days/" + id] || inflight["days/" + id]) next[id] = state.days[id]; });
    state.days = next; render();
  }, err => {
    state.readOnly = err.code === "permission-denied";
    state.banner = state.readOnly ? "This account cannot open the list. Ask the owner to add your email to the Firestore rules."
      : "Live updates stopped. Reload the page to reconnect.";
    state.profilesLoaded = state.legacyLoaded = true; rebuild(); render();
  }));
  unsubs.push(onSnapshot(collection(db, "profiles"), snap => {
    const next = {};
    snap.forEach(d => { next[d.id] = d.data(); });
    const mine = "profiles/" + user.uid;
    if ((pending[mine] || inflight[mine]) && state.profiles[user.uid]) next[user.uid] = state.profiles[user.uid];
    state.profiles = next; state.profilesLoaded = true; rebuild(); render();
  }, () => { state.profilesLoaded = true; rebuild(); render(); }));
  unsubs.push(onSnapshot(doc(db, "settings/main"), d => {
    state.legacy = d.exists() ? d.data() : null; state.legacyLoaded = true; rebuild(); render();
  }, () => { state.legacyLoaded = true; rebuild(); render(); }));
});

// Re-render when the app comes back to the foreground (keeps "Today" correct after midnight)
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.user) render(); });
