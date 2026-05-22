const ANSWERS_KEY = "formly_answers_v1";
const SETTINGS_KEY = "formly_settings_v1";
const DEFAULT_SETTINGS = { enabled: true, askBeforeAutofill: true };
let currentSettings = { ...DEFAULT_SETTINGS };

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (result) => resolve(result || {})));
}

function storageSet(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, () => resolve()));
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "this site";
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function persistSettings(partial) {
  currentSettings = { ...currentSettings, ...partial };
  await storageSet({ [SETTINGS_KEY]: currentSettings });
}

async function init() {
  const tab = await getActiveTab();
  const host = hostFromUrl(tab?.url || "");

  const data = await storageGet([ANSWERS_KEY, SETTINGS_KEY]);
  currentSettings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  const answers = data[ANSWERS_KEY] || {};

  document.getElementById("site").textContent = host;
  document.getElementById("count").textContent = Object.keys(answers[host] || {}).length;
  document.getElementById("enabled").checked = currentSettings.enabled;
  document.getElementById("askBeforeAutofill").checked = currentSettings.askBeforeAutofill;

  document.getElementById("enabled").addEventListener("change", async (event) => {
    await persistSettings({ enabled: event.target.checked });
  });

  document.getElementById("askBeforeAutofill").addEventListener("change", async (event) => {
    await persistSettings({ askBeforeAutofill: event.target.checked });
  });

  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

init();
