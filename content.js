(() => {
  const ANSWERS_KEY = "answermate_answers_v1";
  const SETTINGS_KEY = "answermate_settings_v1";

  const DEFAULT_SETTINGS = {
    enabled: true,
    askBeforeAutofill: true
  };

  const FIELD_SELECTOR = [
    "input",
    "textarea",
    "select",
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]'
  ].join(",");

  const sessionIgnoredSaves = new Set();
  const fillOfferCooldown = new WeakMap();
  const observedRoots = new WeakSet();
  let currentBubble = null;
  let currentToast = null;
  let scanTimer = null;

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

  function getBaseDomain(host = getHost()) {
    const parts = String(host || "").split(".").filter(Boolean);
    if (parts.length <= 2) return host;

    const twoPartTlds = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "co.in", "com.au", "com.br", "co.jp"]);
    const lastTwo = parts.slice(-2).join(".");
    if (twoPartTlds.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
    return parts.slice(-2).join(".");
  }

  function isSameBaseDomain(hostA, hostB) {
    return getBaseDomain(hostA) === getBaseDomain(hostB);
  }

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/&nbsp;/g, " ")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanText(text, maxLength = 220) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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

  function isSecurityQuestionText(text) {
    const value = normalize(text);
    if (!value) return false;
    return /\b(security question|security answer|secret question|secret answer|challenge question|challenge answer|verification question|recovery question|memorable answer)\b/.test(value) ||
      /\b(mother|maiden|pet|school|teacher|mascot|nickname|childhood|favorite|favourite|birth city|born|street|first car|first job|where did|what was|what is|who was|name of)\b/.test(value) && /\b(answer|question|what|where|who|which|favorite|favourite|mother|pet|school|city|street)\b/.test(value);
  }

  function isDangerousCredentialText(text) {
    const value = normalize(text);
    if (!value) return false;
    if (isSecurityQuestionText(value)) return false;
    return /\b(password|passcode|otp|one time|2fa|mfa|authenticator|verification code|captcha|card number|credit card|debit card|cvv|cvc|expiry|ssn|social security|bank account|routing number)\b/.test(value);
  }

  function isGenericQuestionText(text) {
    const value = normalize(text);
    return /^(answer|response|question|security|security answer|enter answer|your answer|select|choose|value|field|required)$/.test(value);
  }

  function getTextByIds(ids) {
    return String(ids || "")
      .split(/\s+/)
      .map((id) => {
        try {
          return cleanText(document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "");
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join(" ");
  }

  function getLabelByFor(field) {
    if (!field.id) return "";
    try {
      const root = field.getRootNode?.() || document;
      const label = root.querySelector?.(`label[for="${CSS.escape(field.id)}"]`) || document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
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

  function textWithoutInteractiveElements(node, maxLength = 220) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.("input, textarea, select, button, script, style, svg, option").forEach((el) => el.remove());
    return cleanText(clone.innerText || clone.textContent || "", maxLength);
  }

  function getNearestTextFromAncestor(field) {
    let node = field.parentElement;
    let depth = 0;

    while (node && depth < 7 && node !== document.body) {
      const text = textWithoutInteractiveElements(node, 240);
      if (text.length >= 4 && text.length <= 220 && !/^\*+$/.test(text)) return text;
      node = node.parentElement;
      depth += 1;
    }

    return "";
  }

  function getFieldsetLegend(field) {
    const fieldset = field.closest?.("fieldset");
    return cleanText(fieldset?.querySelector?.("legend")?.innerText || fieldset?.querySelector?.("legend")?.textContent || "");
  }

  function getPreviousElementText(field) {
    const texts = [];
    let el = field.previousElementSibling;
    let attempts = 0;

    while (el && attempts < 6) {
      const text = textWithoutInteractiveElements(el, 180);
      if (text.length >= 2 && text.length <= 180) texts.push(text);
      el = el.previousElementSibling;
      attempts += 1;
    }

    return texts.join(" ");
  }

  function getNearbySelectQuestion(field) {
    const container = field.closest?.("form, fieldset, section, .form-group, .field, .row, div") || field.parentElement;
    if (!container?.querySelectorAll) return "";

    const fieldRect = field.getBoundingClientRect();
    const selects = Array.from(container.querySelectorAll("select"))
      .filter((select) => select !== field && isVisible(select))
      .map((select) => {
        const rect = select.getBoundingClientRect();
        const selectedText = cleanText(select.options?.[select.selectedIndex]?.text || select.getAttribute("aria-label") || select.name || "");
        const labelText = [getLabelByFor(select), getLabelsText(select), cleanText(select.getAttribute("aria-label") || "")].filter(Boolean).join(" ");
        const distance = Math.abs(rect.bottom - fieldRect.top) + Math.abs(rect.left - fieldRect.left);
        return { text: cleanText(`${labelText} ${selectedText}`), distance };
      })
      .filter((item) => item.text && item.distance < 700)
      .sort((a, b) => a.distance - b.distance);

    return cleanText(selects[0]?.text || "");
  }

  function getNearbyGeometryText(field) {
    const root = field.getRootNode?.() || document;
    const fieldRect = field.getBoundingClientRect();
    const candidates = [];
    const selector = "label, span, div, p, dt, dd, th, td, strong, b, small";

    try {
      root.querySelectorAll?.(selector).forEach((el) => {
        if (!isVisible(el) || el.contains(field)) return;
        if (el.querySelector?.("input, textarea, select, button")) return;
        const text = cleanText(el.innerText || el.textContent || "", 180);
        if (text.length < 3 || text.length > 180) return;

        const rect = el.getBoundingClientRect();
        const isAbove = rect.bottom <= fieldRect.top + 12 && fieldRect.top - rect.bottom <= 180;
        const isLeft = rect.right <= fieldRect.left + 18 && Math.abs(rect.top - fieldRect.top) <= 70;
        const overlapsHorizontally = rect.left <= fieldRect.right + 40 && rect.right >= fieldRect.left - 40;

        if (!((isAbove && overlapsHorizontally) || isLeft)) return;

        const verticalDistance = Math.max(0, fieldRect.top - rect.bottom);
        const horizontalDistance = Math.abs(rect.left - fieldRect.left);
        const score = (isSecurityQuestionText(text) ? 0 : 40) + verticalDistance + horizontalDistance / 6;
        candidates.push({ text, score });
      });
    } catch {
      return "";
    }

    candidates.sort((a, b) => a.score - b.score);
    return cleanText(candidates.slice(0, 2).map((item) => item.text).join(" "));
  }

  function candidateScore(text, source = "") {
    const value = cleanText(text);
    const normalized = normalize(value);
    if (!normalized || normalized.length < 2) return -1000;

    let score = 0;
    const sourceWeights = {
      label: 65,
      aria: 62,
      labelledby: 66,
      selectedQuestion: 70,
      previous: 50,
      ancestor: 44,
      geometry: 58,
      fieldset: 52,
      placeholder: 36,
      title: 38,
      data: 28,
      name: 18,
      id: 18
    };

    score += sourceWeights[source] || 20;
    if (value.includes("?")) score += 32;
    if (isSecurityQuestionText(value)) score += 34;
    if (/\b(what|where|when|who|which|favorite|favourite|mother|maiden|pet|school|city|street|teacher)\b/.test(normalized)) score += 18;
    if (/\b(security|secret|challenge|recovery|verification)\b/.test(normalized)) score += 18;
    if (isGenericQuestionText(value)) score -= 42;
    if (isDangerousCredentialText(value)) score -= 60;
    if (normalized.length < 5) score -= 12;
    if (normalized.length > 160) score -= 12;

    return score;
  }

  function getQuestionText(field) {
    const candidates = [
      [getLabelByFor(field), "label"],
      [getLabelsText(field), "label"],
      [cleanText(field.closest?.("label")?.innerText || ""), "label"],
      [getTextByIds(field.getAttribute?.("aria-labelledby") || ""), "labelledby"],
      [getTextByIds(field.getAttribute?.("aria-describedby") || ""), "aria"],
      [cleanText(field.getAttribute?.("aria-label") || ""), "aria"],
      [getNearbySelectQuestion(field), "selectedQuestion"],
      [getPreviousElementText(field), "previous"],
      [getFieldsetLegend(field), "fieldset"],
      [getNearbyGeometryText(field), "geometry"],
      [getNearestTextFromAncestor(field), "ancestor"],
      [cleanText(field.getAttribute?.("placeholder") || ""), "placeholder"],
      [cleanText(field.getAttribute?.("title") || ""), "title"],
      [cleanText(field.getAttribute?.("data-testid") || field.getAttribute?.("data-test") || field.getAttribute?.("data-qa") || ""), "data"],
      [cleanText(field.getAttribute?.("name") || ""), "name"],
      [cleanText(field.id || ""), "id"]
    ];

    let best = { text: "", score: -1000 };
    candidates.forEach(([text, source]) => {
      const cleaned = cleanText(text);
      if (!cleaned) return;
      const score = candidateScore(cleaned, source);
      if (score > best.score) best = { text: cleaned, score };
    });

    if (best.text && normalize(best.text).length >= 2) return best.text;
    return "Unknown question";
  }

  function isTextEntryField(field) {
    if (!field || !(field instanceof HTMLElement)) return false;
    if (field.isContentEditable || field.getAttribute("role") === "textbox") return true;
    const tag = field.tagName.toLowerCase();
    return ["input", "textarea", "select"].includes(tag);
  }

  function isLikelySecurityQuestionSelector(field) {
    if (!field || field.tagName?.toLowerCase() !== "select") return false;
    const selectedText = cleanText(field.options?.[field.selectedIndex]?.text || "");
    const context = getQuestionText(field);
    return isSecurityQuestionText(`${context} ${selectedText}`) && /\?/.test(selectedText);
  }

  function isAllowedField(field) {
    if (!isTextEntryField(field)) return false;
    if (field.disabled || field.readOnly) return false;
    if (field.closest?.('[aria-hidden="true"]')) return false;
    if (!isVisible(field)) return false;

    const tag = field.tagName.toLowerCase();
    if (tag === "textarea" || field.isContentEditable || field.getAttribute("role") === "textbox") return true;
    if (tag === "select") return true;

    const type = (field.getAttribute("type") || "text").toLowerCase();
    const hardBlockedTypes = new Set([
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

    if (hardBlockedTypes.has(type)) return false;

    const question = getQuestionText(field);
    const combinedContext = `${question} ${field.name || ""} ${field.id || ""} ${field.placeholder || ""} ${field.autocomplete || ""}`;

    if (type === "password") return isSecurityQuestionText(combinedContext);
    if (isDangerousCredentialText(combinedContext)) return false;

    return true;
  }

  function getFieldFingerprint(field) {
    const form = field.closest?.("form");

    return {
      tag: cleanText(field.tagName.toLowerCase(), 40),
      type: cleanText((field.getAttribute("type") || "text").toLowerCase(), 40),
      id: cleanText(field.id || "", 120),
      name: cleanText(field.getAttribute("name") || "", 120),
      placeholder: cleanText(field.getAttribute("placeholder") || "", 180),
      ariaLabel: cleanText(field.getAttribute("aria-label") || "", 180),
      ariaLabelledBy: getTextByIds(field.getAttribute("aria-labelledby") || ""),
      ariaDescribedBy: getTextByIds(field.getAttribute("aria-describedby") || ""),
      title: cleanText(field.getAttribute("title") || "", 180),
      autocomplete: cleanText(field.getAttribute("autocomplete") || "", 80),
      labelByFor: getLabelByFor(field),
      labelsText: getLabelsText(field),
      previousText: getPreviousElementText(field),
      ancestorText: getNearestTextFromAncestor(field),
      geometryText: getNearbyGeometryText(field),
      selectedQuestionText: getNearbySelectQuestion(field),
      fieldsetLegend: getFieldsetLegend(field),
      dataHint: cleanText(field.getAttribute("data-testid") || field.getAttribute("data-test") || field.getAttribute("data-qa") || "", 120),
      formId: cleanText(form?.id || "", 100),
      formName: cleanText(form?.getAttribute("name") || "", 100)
    };
  }

  function getAnswerStorageKey(question) {
    return normalize(question);
  }

  function getFieldValue(field) {
    if (field.isContentEditable || field.getAttribute("role") === "textbox") return field.innerText || field.textContent || "";
    if (field.tagName.toLowerCase() === "select") return field.value;
    return field.value || "";
  }

  function setNativeValue(field, value) {
    const tag = field.tagName.toLowerCase();
    const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) descriptor.set.call(field, value);
    else field.value = value;
  }

  function setFieldValue(field, value) {
    field.focus();

    if (field.isContentEditable || field.getAttribute("role") === "textbox") {
      field.textContent = value;
    } else if (field.tagName.toLowerCase() === "select") {
      field.value = value;
    } else {
      setNativeValue(field, value);
    }

    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value || "") }));
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

  function scoreRecordMatch(recordKey, record, question, fingerprint, hostPenalty = 0) {
    const currentQuestion = normalize(question);
    const savedQuestion = normalize(record?.question || recordKey || "");
    const savedFingerprint = record?.fingerprint || record?.signatures || {};
    let score = 0;

    if (recordKey === currentQuestion) score = Math.max(score, 100);
    if (savedQuestion && savedQuestion === currentQuestion) score = Math.max(score, 100);

    const questionSimilarity = tokenSimilarity(savedQuestion, currentQuestion);
    if (questionSimilarity >= 0.9) score = Math.max(score, 94);
    else if (questionSimilarity >= 0.75) score = Math.max(score, 82);
    else if (questionSimilarity >= 0.58 && isSecurityQuestionText(`${savedQuestion} ${currentQuestion}`)) score = Math.max(score, 74);

    const comparisons = [
      ["id", 88],
      ["name", 84],
      ["placeholder", 82],
      ["ariaLabel", 88],
      ["ariaLabelledBy", 92],
      ["ariaDescribedBy", 78],
      ["title", 72],
      ["autocomplete", 74],
      ["labelByFor", 92],
      ["labelsText", 92],
      ["previousText", 78],
      ["ancestorText", 76],
      ["geometryText", 84],
      ["selectedQuestionText", 94],
      ["fieldsetLegend", 78],
      ["dataHint", 72]
    ];

    comparisons.forEach(([fieldName, fieldScore]) => {
      const left = normalize(fingerprint[fieldName] || "");
      const right = normalize(savedFingerprint[fieldName] || "");
      if (!left || !right) return;
      if (left === right && left.length >= 2) score = Math.max(score, fieldScore);

      const similarity = tokenSimilarity(left, right);
      if (similarity >= 0.88 && left.length >= 4 && right.length >= 4) {
        score = Math.max(score, Math.min(fieldScore - 2, 90));
      } else if (similarity >= 0.7 && isSecurityQuestionText(`${left} ${right}`)) {
        score = Math.max(score, Math.min(fieldScore - 8, 82));
      }
    });

    const sameForm =
      normalize(fingerprint.formId || fingerprint.formName) &&
      normalize(fingerprint.formId || fingerprint.formName) === normalize(savedFingerprint.formId || savedFingerprint.formName);

    if (sameForm && score >= 68) score += 5;

    return Math.max(0, Math.min(score - hostPenalty, 100));
  }

  async function findSavedAnswer(field, question) {
    const answers = await getAnswers();
    const currentHost = getHost();
    const key = getAnswerStorageKey(question);
    const fingerprint = getFieldFingerprint(field);

    const hostEntries = Object.entries(answers).filter(([host]) => host === currentHost || isSameBaseDomain(host, currentHost));

    if (answers[currentHost]?.[key]) {
      return { key, host: currentHost, record: answers[currentHost][key], score: 100 };
    }

    let bestKey = "";
    let bestHost = currentHost;
    let bestRecord = null;
    let bestScore = 0;

    hostEntries.forEach(([host, hostAnswers]) => {
      const hostPenalty = host === currentHost ? 0 : 8;
      Object.entries(hostAnswers || {}).forEach(([recordKey, record]) => {
        const score = scoreRecordMatch(recordKey, record, question, fingerprint, hostPenalty);
        if (score > bestScore) {
          bestScore = score;
          bestKey = recordKey;
          bestHost = host;
          bestRecord = record;
        }
      });
    });

    if (bestRecord && bestScore >= 70) {
      return { key: bestKey, host: bestHost, record: bestRecord, score: bestScore };
    }

    return { key, host: currentHost, record: null, score: 0 };
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
    currentToast.className = "answermate-toast";
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
    bubble.className = "answermate-bubble";
    bubble.style.left = `${Math.max(8, Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 348))}px`;
    bubble.style.top = `${window.scrollY + rect.bottom + 8}px`;

    bubble.innerHTML = `
      <div class="answermate-badge">
        <svg viewBox="0 0 24 24" class="answermate-badge-icon" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2" ry="2" />
          <path d="M8 11V7a4 4 0 018 0v4" />
        </svg>
        AnswerMate
      </div>
      <div class="answermate-bubble-title"></div>
      <div class="answermate-bubble-question"></div>
      <div class="answermate-bubble-actions">
        <button class="answermate-secondary" type="button"></button>
        <button class="answermate-primary" type="button"></button>
      </div>
    `;

    bubble.querySelector(".answermate-bubble-title").textContent = title;
    bubble.querySelector(".answermate-bubble-question").textContent = cleanText(question);

    const secondaryButton = bubble.querySelector(".answermate-secondary");
    const primaryButton = bubble.querySelector(".answermate-primary");
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
    if (isLikelySecurityQuestionSelector(field)) return;

    const value = cleanText(getFieldValue(field), 1000);
    if (!value || value.length < 1) return;

    const question = getQuestionText(field);
    if (isDangerousCredentialText(question)) return;

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
        showToast("Saved in AnswerMate.");
      },
      async () => {
        sessionIgnoredSaves.add(sessionKey);
      }
    );
  }

  async function maybeOfferFill(field, force = false) {
    const settings = await getSettings();
    if (!settings.enabled || !isAllowedField(field)) return;
    if (isLikelySecurityQuestionSelector(field)) return;
    if (cleanText(getFieldValue(field), 1000)) return;

    const now = Date.now();
    const previousOffer = fillOfferCooldown.get(field) || 0;
    if (!force && now - previousOffer < 900) return;
    fillOfferCooldown.set(field, now);

    const question = getQuestionText(field);
    const { record } = await findSavedAnswer(field, question);
    if (!record || !record.answer) return;

    if (!settings.askBeforeAutofill) {
      setFieldValue(field, record.answer);
      showToast("Filled from AnswerMate.");
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
        showToast("Filled from AnswerMate.");
      },
      async () => {}
    );
  }

  function bindField(field) {
    if (!isAllowedField(field)) return;
    if (field.dataset?.answermateBound === "true") return;
    if (field.dataset) field.dataset.answermateBound = "true";

    field.addEventListener("focus", () => {
      maybeOfferFill(field, true);
    });

    field.addEventListener("click", () => {
      maybeOfferFill(field);
    });

    field.addEventListener("input", () => {
      if (getFieldValue(field)) fillOfferCooldown.set(field, Date.now());
    });

    field.addEventListener("blur", () => {
      setTimeout(() => maybeOfferSave(field), 120);
    });

    if (document.activeElement === field) {
      setTimeout(() => maybeOfferFill(field, true), 250);
    }
  }

  function scanRoot(root) {
    if (!root?.querySelectorAll) return;
    if (!observedRoots.has(root)) {
      try {
        observer.observe(root, { childList: true, subtree: true });
        observedRoots.add(root);
      } catch {}
    }

    root.querySelectorAll(FIELD_SELECTOR).forEach(bindField);
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) scanRoot(el.shadowRoot);
    });
  }

  function scan() {
    scanRoot(document);
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 150);
  }

  const observer = new MutationObserver(scheduleScan);

  document.addEventListener(
    "focusin",
    (event) => {
      const path = event.composedPath?.() || [event.target];
      path.forEach((item) => {
        if (item instanceof HTMLElement && isTextEntryField(item)) {
          bindField(item);
          maybeOfferFill(item, true);
        }
      });
    },
    true
  );

  document.addEventListener("click", (event) => {
    if (!currentBubble) return;
    if (currentBubble.contains(event.target)) return;
    closeBubble();
  });

  window.addEventListener("resize", closeBubble);
  window.addEventListener("scroll", closeBubble, true);

  scan();
})();
