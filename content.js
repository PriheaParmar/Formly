(() => {
  const ANSWERS_KEY = "formly_answers_v1";
  const SETTINGS_KEY = "formly_settings_v1";

  const DEFAULT_SETTINGS = {
    enabled: true,
    askBeforeAutofill: true
  };

  const sessionIgnoredSaves = new Set();
  const fillOfferCooldown = new WeakMap();
  const saveOfferTimers = new WeakMap();
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

  function getNearbyIdentityText(field) {
    const pieces = [
      field.id,
      field.getAttribute("name"),
      field.getAttribute("placeholder"),
      field.getAttribute("aria-label"),
      field.getAttribute("autocomplete"),
      field.getAttribute("title"),
      field.getAttribute("data-testid"),
      field.getAttribute("data-test"),
      field.getAttribute("data-name")
    ];

    try {
      Array.from(field.labels || []).forEach((label) => {
        pieces.push(label.innerText || label.textContent || "");
      });
    } catch {}

    let previous = field.previousElementSibling;
    let attempts = 0;
    while (previous && attempts < 4) {
      pieces.push(previous.innerText || previous.textContent || "");
      previous = previous.previousElementSibling;
      attempts += 1;
    }

    let node = field.parentElement;
    let depth = 0;
    while (node && depth < 4 && node !== document.body) {
      const clone = node.cloneNode(true);
      clone.querySelectorAll("input, textarea, select, button, script, style, svg").forEach((el) => el.remove());
      pieces.push(clone.innerText || clone.textContent || "");
      node = node.parentElement;
      depth += 1;
    }

    const form = field.closest("form");
    pieces.push(form?.id, form?.getAttribute("name"), form?.getAttribute("action"));

    return cleanText(pieces.filter(Boolean).join(" "), 1200);
  }

  function looksLikeSecurityAnswerField(field) {
    const text = normalize(getNearbyIdentityText(field));
    if (!text) return false;

    const securitySignals = [
      "security question",
      "security answer",
      "secret question",
      "secret answer",
      "challenge question",
      "challenge answer",
      "securityquestion",
      "securityanswer"
    ];

    if (securitySignals.some((signal) => text.includes(signal))) return true;

    const questionWords = ["what", "where", "which", "who", "when", "city", "town", "company", "school", "pet", "mother", "first job"];
    return text.includes("question") && questionWords.some((word) => text.includes(word));
  }

  function isAllowedField(field) {
    if (!field || !(field instanceof HTMLElement)) return false;

    const tag = field.tagName.toLowerCase();
    if (!["input", "textarea", "select"].includes(tag)) return false;

    const type = (field.getAttribute("type") || "text").toLowerCase();
    const blockedTypes = new Set([
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

    // Real password fields stay blocked. Security-question answers are often coded
    // as type="password", so Formly allows only those password-style fields when
    // nearby text clearly says it is a security/challenge question.
    if (type === "password" && !looksLikeSecurityAnswerField(field)) return false;

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

  function isVisibleNode(node) {
    const element = node?.parentElement;
    if (!element) return false;

    const tag = element.tagName?.toLowerCase();
    if (["script", "style", "noscript", "svg"].includes(tag)) return false;

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;

    return true;
  }

  function isGenericQuestionLabel(text) {
    const value = normalize(text);
    if (!value) return true;

    const genericPatterns = [
      /^security question ?\d*$/,
      /^security question ?\d* required$/,
      /^challenge question ?\d*$/,
      /^secret question ?\d*$/,
      /^security answer ?\d*$/,
      /^answer ?\d*$/,
      /^question ?\d*$/,
      /^what s this$/,
      /^whats this$/,
      /^help$/,
      /^required$/,
      /^continue$/,
      /^cancel$/
    ];

    return genericPatterns.some((pattern) => pattern.test(value));
  }

  function looksLikeActualQuestion(text) {
    const cleaned = cleanText(text, 240);
    const value = normalize(cleaned);
    if (!value || isGenericQuestionLabel(value)) return false;

    const starters = [
      "what",
      "where",
      "which",
      "who",
      "when",
      "how",
      "in what",
      "in which",
      "name",
      "enter"
    ];

    if (cleaned.includes("?")) return true;
    return starters.some((starter) => value.startsWith(starter + " ") || value === starter);
  }

  function getNearbyQuestionByLayout(field) {
    const fieldRect = field.getBoundingClientRect();
    const candidates = [];

    if (!fieldRect || fieldRect.width === 0 || fieldRect.height === 0) return "";

    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const raw = cleanText(node.textContent || "", 240);
      if (!raw || raw.length < 2) continue;
      if (!isVisibleNode(node)) continue;

      const relation = node.compareDocumentPosition(field);
      if (!(relation & Node.DOCUMENT_POSITION_FOLLOWING)) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      range.detach?.();

      rects.forEach((rect) => {
        if (!rect || rect.width === 0 || rect.height === 0) return;
        const verticalDistance = fieldRect.top - rect.bottom;
        if (verticalDistance < -4 || verticalDistance > 180) return;

        const horizontalOverlap = Math.min(rect.right, fieldRect.right) - Math.max(rect.left, fieldRect.left);
        const horizontallyClose = horizontalOverlap > 0 || Math.abs(rect.left - fieldRect.left) < 360;
        if (!horizontallyClose) return;

        candidates.push({
          text: raw,
          distance: Math.abs(verticalDistance),
          isQuestion: looksLikeActualQuestion(raw),
          isGeneric: isGenericQuestionLabel(raw)
        });
      });
    }

    const good = candidates
      .filter((item) => !item.isGeneric)
      .sort((a, b) => {
        if (a.isQuestion !== b.isQuestion) return a.isQuestion ? -1 : 1;
        return a.distance - b.distance;
      });

    return cleanText(good[0]?.text || "", 180);
  }

  function getSecurityQuestionText(field) {
    const layoutQuestion = getNearbyQuestionByLayout(field);
    if (looksLikeActualQuestion(layoutQuestion)) return layoutQuestion;

    const ancestorText = getNearestTextFromAncestor(field);
    if (ancestorText) {
      const parts = ancestorText
        .split(/(?<=[?])\s+|\n|\r| {2,}/)
        .map((part) => cleanText(part, 180))
        .filter(Boolean);

      const actual = parts.find((part) => looksLikeActualQuestion(part));
      if (actual) return actual;
    }

    return layoutQuestion;
  }

  function getQuestionText(field) {
    // Security-question pages often use generic labels like "Security Question 1"
    // while the real random question is plain text above the input. Use the actual
    // visible question sentence as the storage key so random slots still match.
    if (looksLikeSecurityAnswerField(field)) {
      const securityQuestion = getSecurityQuestionText(field);
      if (securityQuestion && !isGenericQuestionLabel(securityQuestion)) return securityQuestion;
    }

    const candidates = [
      getNearbyQuestionByLayout(field),
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

    return candidates.find((text) => text && normalize(text).length >= 2 && !isGenericQuestionLabel(text)) || "Unknown question";
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
      layoutQuestion: getNearbyQuestionByLayout(field),
      actualQuestion: getQuestionText(field),
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

    field.addEventListener("input", () => {
      if (!looksLikeSecurityAnswerField(field)) return;
      clearTimeout(saveOfferTimers.get(field));
      const timer = setTimeout(() => maybeOfferSave(field), 900);
      saveOfferTimers.set(field, timer);
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