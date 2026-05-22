(() => {
  const ANSWERS_KEY = "formly_answers_v1";
  const SETTINGS_KEY = "formly_settings_v1";

  const DEFAULT_SETTINGS = {
    enabled: true,
    askBeforeAutofill: true
  };

  const sessionIgnoredSaves = new Set();
  const fillOfferCooldown = new WeakMap();
  let currentBubble = null;
  let currentToast = null;

  function isExtensionContextAvailable() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!isExtensionContextAvailable()) return resolve({});
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      if (!isExtensionContextAvailable()) return resolve();
      chrome.storage.local.set(value, () => resolve());
    });
  }

  function getHost() {
    return window.location.hostname.replace(/^www\./, "");
  }

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanText(text, maxLength = 180) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function tokenSimilarity(a, b) {
    const left = new Set(normalize(a).split(" ").filter((word) => word.length > 1));
    const right = new Set(normalize(b).split(" ").filter((word) => word.length > 1));

    if (!left.size || !right.size) return 0;

    let overlap = 0;
    left.forEach((word) => {
      if (right.has(word)) overlap += 1;
    });

    return overlap / Math.max(left.size, right.size);
  }

  function isAllowedField(field) {
    if (!field || !(field instanceof HTMLElement)) return false;

    const tag = field.tagName.toLowerCase();
    if (!["input", "textarea", "select"].includes(tag)) return false;

    const type = (field.getAttribute("type") || "text").toLowerCase();
    const blockedTypes = new Set([
      "password",
      "hidden",
      "file",
      "submit",
      "button",
      "reset",
      "image",
      "radio",
      "checkbox",
      "color",
      "range",
      "date",
      "datetime-local",
      "month",
      "time",
      "week"
    ]);

    if (blockedTypes.has(type)) return false;
    if (field.disabled || field.readOnly) return false;
    if (field.closest('[aria-hidden="true"]')) return false;

    return true;
  }

  function getLabelByFor(field) {
    if (!field.id) return "";
    try {
      const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
      return cleanText(label?.innerText || label?.textContent || "");
    } catch {
      return "";
    }
  }

  function getLabelsText(field) {
    try {
      return Array.from(field.labels || [])
        .map((label) => cleanText(label.innerText || label.textContent || ""))
        .filter(Boolean)
        .join(" ");
    } catch {
      return "";
    }
  }

  function getNearestTextFromAncestor(field) {
    let node = field.parentElement;
    let depth = 0;

    while (node && depth < 5 && node !== document.body) {
      const clone = node.cloneNode(true);
      clone.querySelectorAll("input, textarea, select, button, script, style, svg").forEach((el) => el.remove());
      const text = cleanText(clone.innerText || clone.textContent || "");

      if (text.length >= 4 && text.length <= 160) return text;
      node = node.parentElement;
      depth += 1;
    }

    return "";
  }

  function getPreviousElementText(field) {
    let el = field.previousElementSibling;
    let attempts = 0;

    while (el && attempts < 4) {
      const text = cleanText(el.innerText || el.textContent || "");
      if (text.length >= 2 && text.length <= 160) return text;
      el = el.previousElementSibling;
      attempts += 1;
    }

    return "";
  }

  function getQuestionText(field) {
    const candidates = [
      getLabelByFor(field),
      getLabelsText(field),
      cleanText(field.closest("label")?.innerText || ""),
      cleanText(field.getAttribute("aria-label") || ""),
      cleanText(field.getAttribute("placeholder") || ""),
      getPreviousElementText(field),
      getNearestTextFromAncestor(field),
      cleanText(field.getAttribute("name") || ""),
      cleanText(field.id || "")
    ];

    return candidates.find((text) => text && normalize(text).length >= 2) || "Unknown question";
  }

  function getFieldFingerprint(field) {
    const form = field.closest("form");

    return {
      tag: cleanText(field.tagName.toLowerCase(), 40),
      type: cleanText((field.getAttribute("type") || "text").toLowerCase(), 40),
      id: cleanText(field.id || "", 120),
      name: cleanText(field.getAttribute("name") || "", 120),
      placeholder: cleanText(field.getAttribute("placeholder") || "", 180),
      ariaLabel: cleanText(field.getAttribute("aria-label") || "", 180),
      autocomplete: cleanText(field.getAttribute("autocomplete") || "", 80),
      labelByFor: getLabelByFor(field),
      labelsText: getLabelsText(field),
      previousText: getPreviousElementText(field),
      formId: cleanText(form?.id || "", 100),
      formName: cleanText(form?.getAttribute("name") || "", 100)
    };
  }

  function getAnswerStorageKey(question) {
    return normalize(question);
  }

  function getFieldValue(field) {
    if (field.tagName.toLowerCase() === "select") return field.value;
    return field.value || "";
  }

  function setFieldValue(field, value) {
    field.focus();
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function getSettings() {
    const data = await storageGet([SETTINGS_KEY]);
    return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  }

  async function getAnswers() {
    const data = await storageGet([ANSWERS_KEY]);
    return data[ANSWERS_KEY] || {};
  }

  async function saveAnswer(host, key, record) {
    const answers = await getAnswers();
    answers[host] = answers[host] || {};
    answers[host][key] = record;
    await storageSet({ [ANSWERS_KEY]: answers });
  }

  function scoreRecordMatch(recordKey, record, question, fingerprint) {
    const currentQuestion = normalize(question);
    const savedQuestion = normalize(record?.question || recordKey || "");
    const savedFingerprint = record?.fingerprint || record?.signatures || {};
    let score = 0;

    if (recordKey === currentQuestion) score = Math.max(score, 100);
    if (savedQuestion && savedQuestion === currentQuestion) score = Math.max(score, 100);

    const questionSimilarity = tokenSimilarity(savedQuestion, currentQuestion);
    if (questionSimilarity >= 0.85) score = Math.max(score, 92);
    else if (questionSimilarity >= 0.7) score = Math.max(score, 78);

    const comparisons = [
      ["id", 90],
      ["name", 84],
      ["placeholder", 90],
      ["ariaLabel", 88],
      ["autocomplete", 76],
      ["labelByFor", 92],
      ["labelsText", 92],
      ["previousText", 76]
    ];

    comparisons.forEach(([fieldName, fieldScore]) => {
      const left = normalize(fingerprint[fieldName] || "");
      const right = normalize(savedFingerprint[fieldName] || "");
      if (!left || !right) return;
      if (left === right && left.length >= 2) score = Math.max(score, fieldScore);

      const similarity = tokenSimilarity(left, right);
      if (similarity >= 0.85 && left.length >= 4 && right.length >= 4) {
        score = Math.max(score, Math.min(fieldScore - 2, 88));
      }
    });

    const sameForm =
      normalize(fingerprint.formId || fingerprint.formName) &&
      normalize(fingerprint.formId || fingerprint.formName) === normalize(savedFingerprint.formId || savedFingerprint.formName);

    if (sameForm && score >= 70) score += 5;

    return Math.min(score, 100);
  }

  async function findSavedAnswer(field, question) {
    const answers = await getAnswers();
    const hostAnswers = answers[getHost()] || {};
    const key = getAnswerStorageKey(question);
    const fingerprint = getFieldFingerprint(field);

    if (hostAnswers[key]) {
      return { key, record: hostAnswers[key], score: 100 };
    }

    let bestKey = "";
    let bestRecord = null;
    let bestScore = 0;

    Object.entries(hostAnswers).forEach(([recordKey, record]) => {
      const score = scoreRecordMatch(recordKey, record, question, fingerprint);
      if (score > bestScore) {
        bestScore = score;
        bestKey = recordKey;
        bestRecord = record;
      }
    });

    if (bestRecord && bestScore >= 70) {
      return { key: bestKey, record: bestRecord, score: bestScore };
    }

    return { key, record: null, score: 0 };
  }

  function closeBubble() {
    if (currentBubble) {
      currentBubble.remove();
      currentBubble = null;
    }
  }

  function showToast(message) {
    if (currentToast) currentToast.remove();
    currentToast = document.createElement("div");
    currentToast.className = "formly-toast";
    currentToast.textContent = message;
    document.documentElement.appendChild(currentToast);
    setTimeout(() => {
      currentToast?.remove();
      currentToast = null;
    }, 2200);
  }

  function showBubble(field, title, question, primaryText, secondaryText, onPrimary, onSecondary) {
    closeBubble();

    const rect = field.getBoundingClientRect();
    const bubble = document.createElement("div");
    bubble.className = "formly-bubble";
    bubble.style.left = `${Math.max(8, Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 348))}px`;
    bubble.style.top = `${window.scrollY + rect.bottom + 8}px`;

    // Updated HTML structure to include the lock SVG instead of the dot
    bubble.innerHTML = `
      <div class="formly-badge">
        <svg viewBox="0 0 24 24" class="formly-badge-icon" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2" ry="2" />
          <path d="M8 11V7a4 4 0 018 0v4" />
        </svg>
        Formly
      </div>
      <div class="formly-bubble-title"></div>
      <div class="formly-bubble-question"></div>
      <div class="formly-bubble-actions">
        <button class="formly-secondary" type="button"></button>
        <button class="formly-primary" type="button"></button>
      </div>
    `;

    bubble.querySelector(".formly-bubble-title").textContent = title;
    bubble.querySelector(".formly-bubble-question").textContent = cleanText(question);

    const secondaryButton = bubble.querySelector(".formly-secondary");
    const primaryButton = bubble.querySelector(".formly-primary");
    secondaryButton.textContent = secondaryText;
    primaryButton.textContent = primaryText;

    primaryButton.addEventListener("click", async () => {
      closeBubble();
      await onPrimary?.();
    });

    secondaryButton.addEventListener("click", async () => {
      closeBubble();
      await onSecondary?.();
    });

    document.documentElement.appendChild(bubble);
    currentBubble = bubble;
  }

  async function maybeOfferSave(field) {
    const settings = await getSettings();
    if (!settings.enabled || !isAllowedField(field)) return;

    const value = cleanText(getFieldValue(field), 1000);
    if (!value || value.length < 1) return;

    const question = getQuestionText(field);
    const { key, record } = await findSavedAnswer(field, question);
    if (record && record.answer === value) return;

    const sessionKey = `${getHost()}::${key}::${value}`;
    if (sessionIgnoredSaves.has(sessionKey)) return;

    showBubble(
      field,
      "Save this answer for later?",
      question,
      "Save",
      "Not now",
      async () => {
        await saveAnswer(getHost(), getAnswerStorageKey(question), {
          question,
          answer: value,
          fingerprint: getFieldFingerprint(field),
          updatedAt: Date.now()
        });
        showToast("Saved in Formly.");
      },
      async () => {
        sessionIgnoredSaves.add(sessionKey);
      }
    );
  }

  async function maybeOfferFill(field, force = false) {
    const settings = await getSettings();
    if (!settings.enabled || !isAllowedField(field)) return;
    if (getFieldValue(field)) return;

    const now = Date.now();
    const previousOffer = fillOfferCooldown.get(field) || 0;
    if (!force && now - previousOffer < 900) return;
    fillOfferCooldown.set(field, now);

    const question = getQuestionText(field);
    const { record } = await findSavedAnswer(field, question);
    if (!record || !record.answer) return;

    if (!settings.askBeforeAutofill) {
      setFieldValue(field, record.answer);
      showToast("Filled from Formly.");
      return;
    }

    showBubble(
      field,
      "Use your saved answer?",
      question,
      "Fill",
      "Skip",
      async () => {
        setFieldValue(field, record.answer);
        showToast("Filled from Formly.");
      },
      async () => {}
    );
  }

  function bindField(field) {
    if (!isAllowedField(field)) return;
    if (field.dataset.formlyBound === "true") return;
    field.dataset.formlyBound = "true";

    field.addEventListener("focus", () => {
      maybeOfferFill(field, true);
    });

    field.addEventListener("click", () => {
      maybeOfferFill(field);
    });

    field.addEventListener("blur", () => {
      setTimeout(() => maybeOfferSave(field), 120);
    });

    if (document.activeElement === field) {
      setTimeout(() => maybeOfferFill(field, true), 250);
    }
  }

  function scan() {
    document.querySelectorAll("input, textarea, select").forEach(bindField);
  }

  document.addEventListener("click", (event) => {
    if (!currentBubble) return;
    if (currentBubble.contains(event.target)) return;
    closeBubble();
  });

  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  scan();
})();