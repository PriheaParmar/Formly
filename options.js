const ANSWERS_KEY = "formly_answers_v1";
const SECURITY_KEY = "formly_security_v1";

// --- SVG Icons ---
const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>`;
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const DELETE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

let unlockUntil = 0;
let modalResolve = null;
let expandedHosts = new Set();
let currentQuery = "";
let expandAllMode = false;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (result) => resolve(result || {})));
}

function storageSet(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, () => resolve()));
}

async function getAnswers() {
  const data = await storageGet([ANSWERS_KEY]);
  return data[ANSWERS_KEY] || {};
}

async function saveAnswers(answers) {
  await storageSet({ [ANSWERS_KEY]: answers });
}

async function getSecurity() {
  const data = await storageGet([SECURITY_KEY]);
  return data[SECURITY_KEY] || {};
}

async function saveSecurity(security) {
  await storageSet({ [SECURITY_KEY]: security });
}

async function sha256(text) {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskAnswer(answer) {
  const value = String(answer || "");
  if (!value) return "••••";
  if (value.length <= 2) return "••";
  if (value.length <= 6) return `${value[0]}•••${value[value.length - 1]}`;
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function updateSummary(answers) {
  const hosts = Object.keys(answers);
  const totalAnswers = hosts.reduce((count, host) => count + Object.keys(answers[host] || {}).length, 0);
  document.getElementById("siteCount").textContent = hosts.length;
  document.getElementById("answerCount").textContent = totalAnswers;
}

function setPinButtonText(security) {
  document.getElementById("pinButton").textContent = security.pinHash ? "Change PIN" : "Set PIN";
}

function setExpandButtonText() {
  document.getElementById("expandBtn").textContent = expandAllMode ? "Collapse all" : "Expand all";
}

function openPinModal(mode) {
  const modal = document.getElementById("pinModal");
  const title = document.getElementById("modalTitle");
  const sub = document.getElementById("modalSub");
  const input = document.getElementById("pinInput");
  const confirm = document.getElementById("pinConfirmInput");
  const error = document.getElementById("modalError");
  const submit = document.getElementById("pinSubmit");

  input.value = "";
  confirm.value = "";
  error.textContent = "";

  if (mode === "setup") {
    title.textContent = "Set reveal PIN";
    sub.textContent = "Used only inside Formly.";
    input.placeholder = "New PIN";
    confirm.placeholder = "Confirm PIN";
    confirm.classList.remove("hidden");
    submit.textContent = "Save PIN";
  } else if (mode === "change") {
    title.textContent = "New reveal PIN";
    sub.textContent = "Choose a new Formly PIN.";
    input.placeholder = "New PIN";
    confirm.placeholder = "Confirm PIN";
    confirm.classList.remove("hidden");
    submit.textContent = "Update PIN";
  } else {
    title.textContent = "Reveal answer";
    sub.textContent = "Enter your Formly PIN.";
    input.placeholder = "PIN";
    confirm.classList.add("hidden");
    submit.textContent = "Continue";
  }

  modal.classList.remove("hidden");
  setTimeout(() => input.focus(), 50);

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closePinModal(result) {
  const modal = document.getElementById("pinModal");
  modal.classList.add("hidden");
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}

function getPinModalValue() {
  return {
    pin: document.getElementById("pinInput").value.trim(),
    confirmPin: document.getElementById("pinConfirmInput").value.trim()
  };
}

async function showModalErrorThenRetry(message) {
  const modal = document.getElementById("pinModal");
  const error = document.getElementById("modalError");
  modal.classList.remove("hidden");
  error.textContent = message;
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function setupPin(mode = "setup") {
  const result = await openPinModal(mode);
  if (!result?.ok) return false;

  const { pin, confirmPin } = result;
  if (pin.length < 4) {
    await showModalErrorThenRetry("Use at least 4 characters.");
    return setupPin(mode);
  }

  if (pin !== confirmPin) {
    await showModalErrorThenRetry("PINs do not match.");
    return setupPin(mode);
  }

  await saveSecurity({
    pinHash: await sha256(pin),
    updatedAt: Date.now()
  });

  unlockUntil = Date.now() + 5 * 60 * 1000;
  setPinButtonText(await getSecurity());
  return true;
}

async function verifyPin() {
  const security = await getSecurity();
  if (!security.pinHash) return setupPin("setup");
  if (Date.now() < unlockUntil) return true;

  const result = await openPinModal("verify");
  if (!result?.ok) return false;

  const enteredHash = await sha256(result.pin);
  if (enteredHash !== security.pinHash) {
    await showModalErrorThenRetry("Wrong PIN.");
    return verifyPin();
  }

  unlockUntil = Date.now() + 5 * 60 * 1000;
  return true;
}

async function changePin() {
  const security = await getSecurity();
  if (security.pinHash) {
    const verified = await verifyPin();
    if (!verified) return;
  }
  await setupPin(security.pinHash ? "change" : "setup");
}

async function revealAnswer(answerBox, button, answer) {
  const allowed = await verifyPin();
  if (!allowed) return;
  answerBox.textContent = answer || "";
  answerBox.classList.remove("masked");
  button.innerHTML = EYE_OFF_SVG;
  button.title = "Hide";
  button.dataset.state = "shown";
}

function hideAnswer(answerBox, button, answer) {
  answerBox.textContent = maskAnswer(answer);
  answerBox.classList.add("masked");
  button.innerHTML = EYE_SVG;
  button.title = "Reveal";
  button.dataset.state = "hidden";
}

async function copyAnswer(answer) {
  const allowed = await verifyPin();
  if (!allowed) return;
  await navigator.clipboard.writeText(String(answer || ""));
}

function formatUpdatedAt(timestamp) {
  if (!timestamp) return "Saved";
  const dt = new Date(timestamp);
  if (Number.isNaN(dt.getTime())) return "Saved";
  return `Updated ${dt.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function matchesQuery(host, record, query) {
  if (!query) return true;
  const haystack = `${host} ${record.question || ""} ${record.answer || ""}`.toLowerCase();
  return haystack.includes(query);
}

function makeAnswerCard(host, key, record) {
  const card = document.createElement("div");
  card.className = "answer-card";

  const top = document.createElement("div");
  top.className = "answer-top";

  const questionWrap = document.createElement("div");
  questionWrap.className = "question-wrap";
  questionWrap.innerHTML = `<div class="field-label">Question</div>`;

  const question = document.createElement("div");
  question.className = "question";
  question.textContent = record.question || key;
  questionWrap.appendChild(question);

  const updated = document.createElement("div");
  updated.className = "updated-chip";
  updated.textContent = formatUpdatedAt(record.updatedAt);

  top.append(questionWrap, updated);

  const answerBox = document.createElement("div");
  answerBox.className = "answer-box masked";
  answerBox.textContent = maskAnswer(record.answer);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  // REVEAL BUTTON (SVG updated)
  const revealButton = document.createElement("button");
  revealButton.className = "reveal-btn";
  revealButton.type = "button";
  revealButton.innerHTML = EYE_SVG;
  revealButton.title = "Reveal";
  revealButton.dataset.state = "hidden";
  revealButton.addEventListener("click", async () => {
    if (revealButton.dataset.state === "shown") {
      hideAnswer(answerBox, revealButton, record.answer);
      return;
    }
    await revealAnswer(answerBox, revealButton, record.answer);
  });

  // COPY BUTTON (SVG updated)
  const copyButton = document.createElement("button");
  copyButton.className = "ghost-btn";
  copyButton.type = "button";
  copyButton.innerHTML = COPY_SVG;
  copyButton.title = "Copy";
  copyButton.addEventListener("click", async () => {
    await copyAnswer(record.answer);
    copyButton.innerHTML = CHECK_SVG;
    copyButton.title = "Copied!";
    setTimeout(() => {
      copyButton.innerHTML = COPY_SVG;
      copyButton.title = "Copy";
    }, 900);
  });

  // DELETE BUTTON (SVG updated)
  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-btn";
  deleteButton.type = "button";
  deleteButton.innerHTML = DELETE_SVG;
  deleteButton.title = "Delete";
  deleteButton.addEventListener("click", async () => {
    const confirmed = confirm("Delete this saved answer?");
    if (!confirmed) return;
    const freshAnswers = await getAnswers();
    delete freshAnswers[host][key];
    if (Object.keys(freshAnswers[host] || {}).length === 0) delete freshAnswers[host];
    await saveAnswers(freshAnswers);
    render();
  });

  actions.append(revealButton, copyButton, deleteButton);
  card.append(top, answerBox, actions);
  return card;
}

function makeAccordionCard(host, records) {
  const shouldOpen = currentQuery ? true : expandAllMode || expandedHosts.has(host);
  const card = document.createElement("article");
  card.className = `accordion-card${shouldOpen ? " open" : ""}`;

  const head = document.createElement("button");
  head.className = "accordion-head";
  head.type = "button";
  head.setAttribute("aria-expanded", shouldOpen ? "true" : "false");

  const hostMeta = document.createElement("div");
  hostMeta.className = "host-meta";

  const hostName = document.createElement("div");
  hostName.className = "host-name";
  hostName.textContent = host;

  const hostSub = document.createElement("div");
  hostSub.className = "host-sub";
  hostSub.textContent = `${records.length} match${records.length === 1 ? "" : "es"}`;

  hostMeta.append(hostName, hostSub);

  const hostPill = document.createElement("div");
  hostPill.className = "host-pill";
  hostPill.textContent = `${records.length} saved`;

  // CHEVRON (SVG updated)
  const chevron = document.createElement("div");
  chevron.className = "chevron";
  chevron.innerHTML = CHEVRON_SVG;

  const body = document.createElement("div");
  body.className = "accordion-body";
  records.forEach(([key, record]) => body.appendChild(makeAnswerCard(host, key, record)));

  head.append(hostMeta, hostPill, chevron);
  head.addEventListener("click", () => {
    const isOpen = card.classList.toggle("open");
    head.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (!currentQuery && !expandAllMode) {
      if (isOpen) expandedHosts.add(host);
      else expandedHosts.delete(host);
    }
  });

  card.append(head, body);
  return card;
}

async function render() {
  const list = document.getElementById("list");
  const answers = await getAnswers();
  const security = await getSecurity();
  const query = currentQuery.trim().toLowerCase();

  list.innerHTML = "";
  updateSummary(answers);
  setPinButtonText(security);
  setExpandButtonText();
  document.getElementById("clearSearch").classList.toggle("hidden", !query);

  const hosts = Object.keys(answers).sort();
  if (!hosts.length) {
    list.innerHTML = '<div class="empty">No saved answers yet.</div>';
    return;
  }

  let matchedAny = false;

  hosts.forEach((host, index) => {
    const records = Object.entries(answers[host] || {}).filter(([, record]) => matchesQuery(host, record, query));
    if (!records.length) return;
    matchedAny = true;
    if (!query && !expandAllMode && expandedHosts.size === 0 && index === 0) expandedHosts.add(host);
    list.appendChild(makeAccordionCard(host, records));
  });

  if (!matchedAny) {
    list.innerHTML = '<div class="empty">No matches found.</div>';
  }
}

document.getElementById("pinSubmit").addEventListener("click", () => {
  closePinModal({ ok: true, ...getPinModalValue() });
});

document.getElementById("pinCancel").addEventListener("click", () => closePinModal({ ok: false }));

document.getElementById("pinModal").addEventListener("click", (event) => {
  if (event.target.id === "pinModal") closePinModal({ ok: false });
});

document.addEventListener("keydown", (event) => {
  const modalHidden = document.getElementById("pinModal").classList.contains("hidden");
  if (event.key === "Escape" && !modalHidden) closePinModal({ ok: false });
  if (event.key === "Enter" && !modalHidden) closePinModal({ ok: true, ...getPinModalValue() });
});

document.getElementById("pinButton").addEventListener("click", changePin);
document.getElementById("refreshBtn").addEventListener("click", render);
document.getElementById("searchInput").addEventListener("input", (event) => {
  currentQuery = event.target.value;
  render();
});
document.getElementById("clearSearch").addEventListener("click", () => {
  document.getElementById("searchInput").value = "";
  currentQuery = "";
  render();
});
document.getElementById("expandBtn").addEventListener("click", () => {
  expandAllMode = !expandAllMode;
  if (!expandAllMode) expandedHosts = new Set();
  render();
});
document.getElementById("deleteAll").addEventListener("click", async () => {
  const confirmed = confirm("Delete all saved Formly answers?");
  if (!confirmed) return;
  await saveAnswers({});
  render();
});

render();