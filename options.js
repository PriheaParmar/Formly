const ANSWERS_KEY = "answermate_answers_v1";
const SECURITY_KEY = "answermate_security_v1";

// --- SVG Icons ---
const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>`;
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const DELETE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const CHEVRON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
const EXPAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5C3.9 3 3 3.9 3 5V8"/><path d="M16 3H19C20.1 3 21 3.9 21 5V8"/><path d="M8 21H5C3.9 21 3 20.1 3 19V16"/><path d="M16 21H19C20.1 21 21 20.1 21 19V16"/><path d="M9 9L3.8 3.8"/><path d="M15 9L20.2 3.8"/><path d="M9 15L3.8 20.2"/><path d="M15 15L20.2 20.2"/></svg>`;
const COLLAPSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14H10V20"/><path d="M20 10H14V4"/><path d="M14 10L21 3"/><path d="M10 14L3 21"/></svg>`;

let unlockUntil = 0;
let modalResolve = null;
let expandedHosts = new Set();
let currentQuery = "";
let expandAllMode = false;

const PIN_UNLOCK_MS = 2 * 60 * 1000;
const PIN_PBKDF2_ITERATIONS = 210000;
const PIN_MAX_ATTEMPTS = 4;
const PIN_LOCK_MS = 30 * 1000;

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

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function randomBase64(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

async function legacySha256(text) {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function derivePinHash(pin, salt, iterations = PIN_PBKDF2_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(salt),
      iterations
    },
    keyMaterial,
    256
  );

  return bytesToBase64(bits);
}

function safeCompare(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function validateNewPin(pin) {
  const value = String(pin || "");
  const normalized = value.toLowerCase();

  if (value.length < 6) return "Use at least 6 characters.";
  if (/^(.)\1+$/.test(value)) return "Avoid repeated characters like 111111.";
  if (["123456", "654321", "000000", "111111", "222222", "999999", "password", "qwerty"].includes(normalized)) {
    return "That PIN is too easy to guess.";
  }

  const digitsOnly = /^\d+$/.test(value);
  if (digitsOnly) {
    const ascending = "01234567890123456789".includes(value);
    const descending = "98765432109876543210".includes(value);
    if (ascending || descending) return "Avoid simple number sequences.";
  }

  return "";
}

async function makeSecurityRecord(pin) {
  const salt = randomBase64(16);
  return {
    version: 2,
    algorithm: "PBKDF2-SHA256",
    iterations: PIN_PBKDF2_ITERATIONS,
    salt,
    pinHash: await derivePinHash(pin, salt),
    failedAttempts: 0,
    lockedUntil: 0,
    updatedAt: Date.now()
  };
}

async function verifyPinAgainstSecurity(pin, security) {
  if (security.salt && security.algorithm === "PBKDF2-SHA256") {
    const derived = await derivePinHash(pin, security.salt, security.iterations || PIN_PBKDF2_ITERATIONS);
    return safeCompare(derived, security.pinHash);
  }

  if (security.pinHash) {
    const legacyHash = await legacySha256(pin);
    return safeCompare(legacyHash, security.pinHash);
  }

  return false;
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

function setButtonLabel(buttonId, label) {
  const button = document.getElementById(buttonId);
  const span = button?.querySelector("span");
  if (span) span.textContent = label;
}

function setButtonIcon(buttonId, svg) {
  const button = document.getElementById(buttonId);
  const currentSvg = button?.querySelector("svg");
  if (!button || !currentSvg) return;
  currentSvg.outerHTML = svg;
}

function setPinButtonText(security) {
  setButtonLabel("pinButton", security.pinHash ? "Change PIN" : "Set PIN");
}

function setExpandButtonText() {
  setButtonLabel("expandBtn", expandAllMode ? "Collapse all" : "Expand all");
  setButtonIcon("expandBtn", expandAllMode ? COLLAPSE_SVG : EXPAND_SVG);
}

function openPinModal(mode) {
  const modal = document.getElementById("pinModal");
  const title = document.getElementById("modalTitle");
  const sub = document.getElementById("modalSub");
  const input = document.getElementById("pinInput");
  const confirm = document.getElementById("pinConfirmInput");
  const error = document.getElementById("modalError");

  input.value = "";
  confirm.value = "";
  error.textContent = "";

  if (mode === "setup") {
    title.textContent = "Set vault PIN";
    sub.textContent = "Use 6+ characters. Avoid repeated or simple sequences.";
    input.placeholder = "New PIN or passphrase";
    confirm.placeholder = "Confirm PIN";
    confirm.classList.remove("hidden");
    setButtonLabel("pinSubmit", "Save PIN");
  } else if (mode === "change") {
    title.textContent = "Create new PIN";
    sub.textContent = "Use 6+ characters. Your old PIN was verified first.";
    input.placeholder = "New PIN or passphrase";
    confirm.placeholder = "Confirm PIN";
    confirm.classList.remove("hidden");
    setButtonLabel("pinSubmit", "Update PIN");
  } else if (mode === "current") {
    title.textContent = "Verify current PIN";
    sub.textContent = "Enter your current PIN before changing it.";
    input.placeholder = "Current PIN";
    confirm.classList.add("hidden");
    setButtonLabel("pinSubmit", "Verify");
  } else {
    title.textContent = "Reveal answer";
    sub.textContent = "Enter your AnswerMate PIN.";
    input.placeholder = "PIN";
    confirm.classList.add("hidden");
    setButtonLabel("pinSubmit", "Continue");
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
    pin: document.getElementById("pinInput").value,
    confirmPin: document.getElementById("pinConfirmInput").value
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
  const validationError = validateNewPin(pin);

  if (validationError) {
    await showModalErrorThenRetry(validationError);
    return setupPin(mode);
  }

  if (pin !== confirmPin) {
    await showModalErrorThenRetry("PINs do not match.");
    return setupPin(mode);
  }

  await saveSecurity(await makeSecurityRecord(pin));

  unlockUntil = Date.now() + PIN_UNLOCK_MS;
  setPinButtonText(await getSecurity());
  return true;
}

async function verifyPin(options = {}) {
  const { force = false, mode = "verify" } = options;
  let security = await getSecurity();

  if (!security.pinHash) return setupPin("setup");
  if (!force && Date.now() < unlockUntil) return true;

  if (security.lockedUntil && Date.now() < security.lockedUntil) {
    const seconds = Math.ceil((security.lockedUntil - Date.now()) / 1000);
    await showModalErrorThenRetry(`Too many wrong attempts. Try again in ${seconds}s.`);
    closePinModal({ ok: false });
    return false;
  }

  const result = await openPinModal(mode);
  if (!result?.ok) return false;

  const isValid = await verifyPinAgainstSecurity(result.pin, security);

  if (!isValid) {
    const failedAttempts = (security.failedAttempts || 0) + 1;
    const lockedUntil = failedAttempts >= PIN_MAX_ATTEMPTS ? Date.now() + PIN_LOCK_MS : 0;

    await saveSecurity({
      ...security,
      failedAttempts,
      lockedUntil
    });

    if (lockedUntil) {
      await showModalErrorThenRetry("Too many wrong attempts. Locked for 30 seconds.");
      closePinModal({ ok: false });
      return false;
    }

    await showModalErrorThenRetry(`Wrong PIN. ${PIN_MAX_ATTEMPTS - failedAttempts} attempt${PIN_MAX_ATTEMPTS - failedAttempts === 1 ? "" : "s"} left.`);
    return verifyPin({ force: true, mode });
  }

  // If the user had an old SHA-256-only PIN, migrate it after a successful unlock.
  if (!security.salt || security.algorithm !== "PBKDF2-SHA256") {
    security = await makeSecurityRecord(result.pin);
    await saveSecurity(security);
  } else {
    await saveSecurity({
      ...security,
      failedAttempts: 0,
      lockedUntil: 0,
      lastUnlockedAt: Date.now()
    });
  }

  unlockUntil = Date.now() + PIN_UNLOCK_MS;
  return true;
}

async function changePin() {
  const security = await getSecurity();
  if (security.pinHash) {
    const verified = await verifyPin({ force: true, mode: "current" });
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
  revealButton.className = "reveal-btn icon-btn";
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
  copyButton.className = "ghost-btn icon-btn";
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
  deleteButton.className = "delete-btn icon-btn";
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
  const confirmed = confirm("Delete all saved AnswerMate answers?");
  if (!confirmed) return;
  await saveAnswers({});
  render();
});

render();