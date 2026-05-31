// =========================================================================
// English Forge — Telegram bot for English vocabulary practice.
//
// Pipeline:
//
//   1. sendDailyWordsNow() / cron → startDailySession_()
//      Picks N words, calls GPT to generate practice sentences, builds ONE
//      combined message:
//        - Russian translations (original order) with English answers under
//          per-line <tg-spoiler> blocks.
//        - Practice sentences (shuffled order) with `_____` blanks.
//      Sends that message. Saves session. Done.
//      GPT happens here (outgoing) — Telegram has no timeout for our sends.
//
//   2. doPost() — user replies once with numbered answers in practice order.
//      Parses whatever it finds (any order, partial, gibberish — anything),
//      updates per-word stats in the sheet, builds Review + Stats combined,
//      sends it, clears the session. Always fast (~3-5s).
//
// No async triggers, no GPT in doPost, no Telegram retry games.
//
// Dedup: by Telegram's update_id in Script Properties (LAST_UPDATE_ID).
// Logs: all to hidden sheet `_english_forge_log`, never to chat.
// =========================================================================

const CONFIG = {
  FIRST_DATA_ROW: 2,
  ENGLISH_COL: 2, // B (on main sheet)
  RUSSIAN_COL: 3, // C (on main sheet)

  // Service columns now live on a dedicated sheet `_service_cols`,
  // starting at column A (1). Row N on main sheet ↔ row N on service sheet.
  // 10 columns: 9 original + new `mastery_level` (column J).
  SERVICE_START_COL: 1, // A on the service sheet
  SERVICE_COLS_COUNT: 10,
  SERVICE_SHEET_NAME: '_service_cols',

  DEFAULT_DAILY_WORDS_COUNT: 10,
  MAX_DAILY_WORDS_COUNT: 50,
  DAY_ZERO_DATE: '2026-05-25',

  STATE_SHEET_NAME: '_english_forge_state',
  LOG_SHEET_NAME: '_english_forge_log',
  STATE_KEY_SESSION: 'ACTIVE_SESSION',
  STATE_CHUNK_SIZE: 30000,

  PROP_DAILY_WORDS_COUNT: 'DAILY_WORDS_COUNT',
  PROP_DAY_ZERO_DATE: 'DAY_ZERO_DATE',
  PROP_LAST_UPDATE_ID: 'LAST_UPDATE_ID',
};

const SERVICE = {
  SHOWN_COUNT: 0,
  CORRECT_COUNT: 1,
  WRONG_COUNT: 2,
  LAST_SHOWN: 3,
  LAST_SESSION_ID: 4,
  NEXT_DUE: 5,
  CORRECT_STREAK: 6,
  INTERVAL_DAYS: 7,
  IS_KNOWN: 8,
  MASTERY_LEVEL: 9, // 0-5; primary driver of weight + interval
};

// -------------------------------------------------------------------------
// Properties + sheets
// -------------------------------------------------------------------------

function getProp(name) { return PropertiesService.getScriptProperties().getProperty(name); }
function setProp(name, value) { PropertiesService.getScriptProperties().setProperty(name, value); }
function deleteProp(name) { PropertiesService.getScriptProperties().deleteProperty(name); }

function getSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet. Open Apps Script from the Sheet.');
  return ss;
}

function getSheet_() {
  const ss = getSpreadsheet_();
  const sheetName = getProp('SHEET_NAME');
  if (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
    return sheet;
  }
  // Exclude all internal sheets from the "main sheet" auto-pick.
  const internals = new Set([
    CONFIG.STATE_SHEET_NAME,
    CONFIG.LOG_SHEET_NAME,
    CONFIG.SERVICE_SHEET_NAME,
  ]);
  const visible = ss.getSheets().filter(s => !internals.has(s.getName()));
  return visible[0] || ss.getSheets()[0];
}

function getServiceSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.SERVICE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SERVICE_SHEET_NAME);
    sheet.getRange(1, 1, 1, CONFIG.SERVICE_COLS_COUNT).setValues([[
      'shown_count', 'correct_count', 'wrong_count', 'last_shown', 'last_session_id',
      'next_due', 'correct_streak', 'interval_days', 'is_known', 'mastery_level',
    ]]);
  }
  return sheet;
}

function getStateSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.STATE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.STATE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    try { sheet.hideSheet(); } catch (e) {}
  }
  return sheet;
}

function getLogSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.LOG_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['timestamp', 'kind', 'detail', 'extra']]);
  }
  return sheet;
}

// Per-execution cache of LOG_ENABLED so we don't hit PropertiesService on
// every single log_() call.
let _logEnabledCache = null;

function isLogEnabled_() {
  if (_logEnabledCache === null) {
    // Default: enabled. Only the string 'false' means disabled.
    _logEnabledCache = getProp('LOG_ENABLED') !== 'false';
  }
  return _logEnabledCache;
}

function log_(kind, detail, extra) {
  if (!isLogEnabled_()) return;
  try {
    const sheet = getLogSheet_();
    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([
      ts,
      String(kind || ''),
      String(detail || '').slice(0, 500),
      String(extra || '').slice(0, 500),
    ]);
  } catch (e) {
    Logger.log('log_ failed: ' + (e && e.message));
  }
}

// -------------------------------------------------------------------------
// State sheet: stores ACTIVE_SESSION as JSON (chunked if huge).
// -------------------------------------------------------------------------

function deleteStateValue_(key) {
  const sheet = getStateSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const chunkPrefix = key + '__';
  for (let i = values.length - 1; i >= 0; i--) {
    const currentKey = String(values[i][0] || '');
    if (currentKey === key || currentKey.indexOf(chunkPrefix) === 0) {
      sheet.deleteRow(i + 2);
    }
  }
}

function setStateValue_(key, value) {
  const sheet = getStateSheet_();
  const text = String(value || '');
  deleteStateValue_(key);

  if (text.length <= CONFIG.STATE_CHUNK_SIZE) {
    sheet.appendRow([key, text]);
    return;
  }
  const chunks = [];
  for (let i = 0; i < text.length; i += CONFIG.STATE_CHUNK_SIZE) {
    chunks.push([`${key}__${chunks.length}`, text.slice(i, i + CONFIG.STATE_CHUNK_SIZE)]);
  }
  if (chunks.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, chunks.length, 2).setValues(chunks);
  }
}

function getStateValue_(key) {
  const sheet = getStateSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const chunkPrefix = key + '__';
  const chunks = [];

  for (let i = 0; i < values.length; i++) {
    const currentKey = String(values[i][0] || '');
    const currentValue = String(values[i][1] || '');
    if (currentKey === key) return currentValue;
    if (currentKey.indexOf(chunkPrefix) === 0) {
      const index = Number(currentKey.slice(chunkPrefix.length));
      if (Number.isFinite(index)) chunks.push({ index, value: currentValue });
    }
  }

  if (chunks.length === 0) return '';
  chunks.sort((a, b) => a.index - b.index);
  return chunks.map(c => c.value).join('');
}

function getActiveSession_() {
  const raw = getStateValue_(CONFIG.STATE_KEY_SESSION);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { log_('parse_session_failed', e.message); return null; }
}

function setActiveSession_(session) {
  setStateValue_(CONFIG.STATE_KEY_SESSION, JSON.stringify(session));
}

function clearActiveSession_() {
  deleteStateValue_(CONFIG.STATE_KEY_SESSION);
}

// -------------------------------------------------------------------------
// Date / number / string utilities
// -------------------------------------------------------------------------

function toNumber_(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toDateString_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value).trim();
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDays_(dateString, days) {
  const date = new Date(dateString + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function daysSince_(dateString) {
  if (!dateString) return 999;
  const todayDate = new Date(today_() + 'T00:00:00');
  const oldDate = new Date(dateString + 'T00:00:00');
  return Math.floor((todayDate - oldDate) / (24 * 60 * 60 * 1000));
}

function getDayNumber_() {
  const dayZero = getProp(CONFIG.PROP_DAY_ZERO_DATE) || CONFIG.DAY_ZERO_DATE;
  const todayDate = new Date(today_() + 'T00:00:00');
  const zeroDate = new Date(dayZero + 'T00:00:00');
  const n = Math.floor((todayDate - zeroDate) / (24 * 60 * 60 * 1000));
  return Math.max(0, n);
}

// -------------------------------------------------------------------------
// Outgoing text helpers
// -------------------------------------------------------------------------

function sanitizeOutgoingText_(value) {
  return String(value || '').replace(/—/g, '-').replace(/–/g, '-');
}

function escapeHtml_(value) {
  return sanitizeOutgoingText_(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml_(value) {
  return String(value || '').replace(/<[^>]*>/g, '');
}

function splitTelegramText_(text) {
  const maxLength = 3800;
  const lines = String(text).split('\n');
  const chunks = [];
  let current = '';
  lines.forEach(line => {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  });
  if (current) chunks.push(current);
  return chunks;
}

// -------------------------------------------------------------------------
// Telegram send (with HTML fallback)
// -------------------------------------------------------------------------

function sendTelegramMessage_(text, chatId, useHtml) {
  const token = getProp('TELEGRAM_TOKEN');
  const targetChatId = chatId || getProp('GROUP_CHAT_ID');
  if (!token) throw new Error('TELEGRAM_TOKEN is not set.');
  if (!targetChatId) throw new Error('GROUP_CHAT_ID is not set.');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const html = useHtml !== false;
  const chunks = splitTelegramText_(sanitizeOutgoingText_(text));
  const results = [];

  chunks.forEach(chunk => {
    const payload = { chat_id: targetChatId, text: chunk, disable_web_page_preview: true };
    if (html) payload.parse_mode = 'HTML';

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    let response = UrlFetchApp.fetch(url, options);
    let body = response.getContentText();

    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) {}
    if (parsed && parsed.ok) { results.push(parsed.result); return; }

    if (html) {
      // Fallback: retry without HTML.
      const fallbackPayload = {
        chat_id: targetChatId,
        text: stripHtml_(chunk),
        disable_web_page_preview: true,
      };
      response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(fallbackPayload),
        muteHttpExceptions: true,
      });
      body = response.getContentText();
      try { parsed = JSON.parse(body); } catch (e) {}
      if (parsed && parsed.ok) { results.push(parsed.result); return; }
    }

    throw new Error(`Telegram send failed: ${body}`);
  });

  return results;
}

function sendTelegramMessageSafe_(text, chatId, useHtml) {
  try { return sendTelegramMessage_(text, chatId, useHtml); }
  catch (e) { log_('telegram_send_failed', e.message); return []; }
}

// -------------------------------------------------------------------------
// Webhook admin (run manually from editor when setting up)
// -------------------------------------------------------------------------

function setWebhook() {
  const token = getProp('TELEGRAM_TOKEN');
  if (!token) { log_('setWebhook', 'NO_TOKEN'); return; }

  let url = getProp('WEBHOOK_URL');
  if (!url) {
    try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  }
  if (!url) { log_('setWebhook', 'NO_URL'); return; }
  if (/\/dev(\?|$)/.test(url)) {
    log_('setWebhook', 'REFUSE_DEV_URL', url);
    return;
  }

  const setUrl = `https://api.telegram.org/bot${token}/setWebhook`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ url, drop_pending_updates: true }),
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(setUrl, options);
  log_('setWebhook', url, response.getContentText());
  Logger.log(response.getContentText());
}

function dropTelegramBacklog() {
  const token = getProp('TELEGRAM_TOKEN');
  if (!token) { log_('dropBacklog', 'NO_TOKEN'); return; }

  let url = getProp('WEBHOOK_URL');
  if (!url) {
    try {
      const info = JSON.parse(UrlFetchApp.fetch(
        `https://api.telegram.org/bot${token}/getWebhookInfo`,
        { muteHttpExceptions: true }
      ).getContentText());
      url = info && info.result && info.result.url;
    } catch (e) {}
  }
  if (!url) {
    try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  }
  if (!url) { log_('dropBacklog', 'NO_URL'); return; }

  const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ url, drop_pending_updates: true }),
    muteHttpExceptions: true,
  });
  log_('dropBacklog', url, response.getContentText());
}

// Quiet wrapper used at the end of each command handler. Drops Telegram's
// retry queue for whatever just got processed (otherwise every command
// accumulates retries that show up as repeated doPost_enter rows for hours).
// Never throws — logs only on failure.
function dropBacklogAfterCommand_(label) {
  try {
    dropTelegramBacklog();
    log_('cmd_dropBacklog', label, 'ok');
  } catch (e) {
    log_('cmd_dropBacklog_failed', label, e && e.message);
  }
}

function diagnoseWebhook() {
  const token = getProp('TELEGRAM_TOKEN');
  if (!token) { Logger.log('NO TELEGRAM_TOKEN'); return; }
  const response = UrlFetchApp.fetch(
    `https://api.telegram.org/bot${token}/getWebhookInfo`,
    { muteHttpExceptions: true }
  );
  Logger.log(response.getContentText());
}

// -------------------------------------------------------------------------
// Service column setup
// -------------------------------------------------------------------------

function setupServiceHeaders() {
  const sheet = getServiceSheet_();
  sheet
    .getRange(1, CONFIG.SERVICE_START_COL, 1, CONFIG.SERVICE_COLS_COUNT)
    .setValues([[
      'shown_count', 'correct_count', 'wrong_count', 'last_shown', 'last_session_id',
      'next_due', 'correct_streak', 'interval_days', 'is_known', 'mastery_level',
    ]]);
}

// -------------------------------------------------------------------------
// Load words from sheet (one batch read)
// -------------------------------------------------------------------------

function loadWords_() {
  const sheet = getSheet_();
  const serviceSheet = getServiceSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.FIRST_DATA_ROW) return { sheet, serviceSheet, words: [], serviceValues: [] };

  const rowCount = lastRow - CONFIG.FIRST_DATA_ROW + 1;
  const englishRussian = sheet
    .getRange(CONFIG.FIRST_DATA_ROW, CONFIG.ENGLISH_COL, rowCount, 2)
    .getValues();
  // Read service values from the dedicated service sheet. Row alignment:
  // row N on main ↔ row N on service.
  const serviceValues = serviceSheet
    .getRange(CONFIG.FIRST_DATA_ROW, CONFIG.SERVICE_START_COL, rowCount, CONFIG.SERVICE_COLS_COUNT)
    .getValues();

  const today = today_();
  const words = [];

  for (let i = 0; i < rowCount; i++) {
    const english = String(englishRussian[i][0] || '').trim();
    const russian = String(englishRussian[i][1] || '').trim();

    const s = serviceValues[i];

    // FIX: orphan row — main sheet has no english/russian but service has
    // values. Wipe the service row so deleted/cleared words don't leave
    // ghost stats behind.
    if (!english || !russian) {
      let hasData = false;
      for (let j = 0; j < CONFIG.SERVICE_COLS_COUNT; j++) {
        if (s[j] !== '' && s[j] !== 0 && s[j] !== null) { hasData = true; break; }
      }
      if (hasData) {
        for (let j = 0; j < CONFIG.SERVICE_COLS_COUNT; j++) s[j] = '';
      }
      continue;
    }

    // Defaults for new rows OR rows with empty service columns.
    if (s[SERVICE.SHOWN_COUNT] === '') s[SERVICE.SHOWN_COUNT] = 0;
    if (s[SERVICE.CORRECT_COUNT] === '') s[SERVICE.CORRECT_COUNT] = 0;
    if (s[SERVICE.WRONG_COUNT] === '') s[SERVICE.WRONG_COUNT] = 0;
    if (s[SERVICE.NEXT_DUE] === '') s[SERVICE.NEXT_DUE] = today;
    if (s[SERVICE.CORRECT_STREAK] === '') s[SERVICE.CORRECT_STREAK] = 0;
    if (s[SERVICE.INTERVAL_DAYS] === '') s[SERVICE.INTERVAL_DAYS] = 0;
    if (s[SERVICE.IS_KNOWN] === '') s[SERVICE.IS_KNOWN] = 0;

    // FIX: bootstrap mastery_level if missing. For NEW rows (shown_count=0)
    // it's just 0. For EXISTING rows being migrated from the old schema,
    // derive a sensible starting level from current data so the user
    // doesn't lose progress.
    if (s[SERVICE.MASTERY_LEVEL] === '' || s[SERVICE.MASTERY_LEVEL] === null) {
      const shown = toNumber_(s[SERVICE.SHOWN_COUNT], 0);
      const correctStreak = toNumber_(s[SERVICE.CORRECT_STREAK], 0);
      const wrong = toNumber_(s[SERVICE.WRONG_COUNT], 0);
      const isKnown = toNumber_(s[SERVICE.IS_KNOWN], 0);

      let level = 0;
      if (shown === 0) level = 0;
      else if (isKnown === 1 && correctStreak >= 5) level = 5;
      else if (isKnown === 1 && correctStreak >= 3) level = 4;
      else if (isKnown === 1) level = 3;
      else if (wrong > 0) level = 1;
      else level = 2;
      s[SERVICE.MASTERY_LEVEL] = level;
    }

    words.push({
      rowNumber: CONFIG.FIRST_DATA_ROW + i,
      serviceIndex: i,
      english,
      russian,
      shownCount: toNumber_(s[SERVICE.SHOWN_COUNT], 0),
      correctCount: toNumber_(s[SERVICE.CORRECT_COUNT], 0),
      wrongCount: toNumber_(s[SERVICE.WRONG_COUNT], 0),
      lastShown: toDateString_(s[SERVICE.LAST_SHOWN]),
      lastSessionId: String(s[SERVICE.LAST_SESSION_ID] || ''),
      nextDue: toDateString_(s[SERVICE.NEXT_DUE]) || today,
      correctStreak: toNumber_(s[SERVICE.CORRECT_STREAK], 0),
      intervalDays: toNumber_(s[SERVICE.INTERVAL_DAYS], 0),
      isKnown: toNumber_(s[SERVICE.IS_KNOWN], 0),
      masteryLevel: toNumber_(s[SERVICE.MASTERY_LEVEL], 0),
    });
  }

  // Persist default fills (so empty cells become 0/today/etc) — to the service sheet.
  serviceSheet
    .getRange(CONFIG.FIRST_DATA_ROW, CONFIG.SERVICE_START_COL, rowCount, CONFIG.SERVICE_COLS_COUNT)
    .setValues(serviceValues);

  return { sheet, serviceSheet, words, serviceValues };
}

// -------------------------------------------------------------------------
// Daily word count
// -------------------------------------------------------------------------

function getDailyWordsCount_() {
  const value = Number(getProp(CONFIG.PROP_DAILY_WORDS_COUNT));
  if (!Number.isFinite(value) || value < 1) return CONFIG.DEFAULT_DAILY_WORDS_COUNT;
  return Math.min(value, CONFIG.MAX_DAILY_WORDS_COUNT);
}

function setDailyWordsCount_(count) {
  const safe = Math.max(1, Math.min(Number(count), CONFIG.MAX_DAILY_WORDS_COUNT));
  setProp(CONFIG.PROP_DAILY_WORDS_COUNT, String(safe));
  return safe;
}

// -------------------------------------------------------------------------
// Weighted selection
// -------------------------------------------------------------------------

function isDue_(word) {
  return !word.nextDue || word.nextDue <= today_();
}

function weightWord_(word, dailyCount, totalWords) {
  // scale grows with dailyCount so larger sessions shift harder toward
  // struggling words: 5 → 1.25, 10 → 1.50, 20 → 2.00, 50 → 3.50.
  const scale = 1 + dailyCount / 20;
  let weight = 1;

  // Mastery-level priority (the main signal). The PLASTIC level — not any
  // ever-growing wrong counter — drives selection, so a word stops being
  // hammered as soon as you actually learn it. Levels:
  //   0 NEW            — never attempted (intake is throttled by quota, not weight)
  //   1 STRUGGLING     — attempted, currently failing  → top priority
  //   2 LEARNING       — starting to stick
  //   3 JUST KNOWN     — first time over the threshold
  //   4 KNOWN          — stable
  //   5 MASTERED       — long-term memory; only shows via due-date
  const level = word.masteryLevel || 0;
  if (level === 0) weight += Math.round(4 * scale);
  else if (level === 1) weight += Math.round(12 * scale);
  else if (level === 2) weight += Math.round(7 * scale);
  else if (level === 3) weight += Math.round(2 * scale);
  else if (level === 4) weight += 1;
  // level 5: no bonus, sees the light only when next_due hits.

  // Forgetting catch-up — gradually resurface words you ONCE saw and may be
  // forgetting. Only for words actually shown before: an empty last_shown
  // means "never attempted", which must NOT borrow this neglected-word bonus
  // (that was the old bug that let 500+ unseen words outweigh real failures).
  if (word.lastShown) {
    const days = daysSince_(word.lastShown);
    if (days >= 30) weight += Math.round(4 * scale);
    else if (days >= 14) weight += Math.round(3 * scale);
    else if (days >= 7) weight += Math.round(2 * scale);
    else if (days >= 3) weight += 1;
  }

  return Math.max(1, weight);
}

function weightedPick_(items, count, totalWords) {
  const pool = items.slice();
  const result = [];
  while (pool.length > 0 && result.length < count) {
    const totalWeight = pool.reduce((sum, it) => sum + weightWord_(it, count, totalWords), 0);
    let r = Math.random() * totalWeight;
    let pickIndex = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= weightWord_(pool[i], count, totalWords);
      if (r <= 0) { pickIndex = i; break; }
    }
    result.push(pool[pickIndex]);
    pool.splice(pickIndex, 1);
  }
  return result;
}

function selectDailyWords_(words) {
  const dailyCount = getDailyWordsCount_();
  const due = words.filter(isDue_);

  // Composition goal (the word cycle the user wants):
  //   - The BULK of every session is the words you keep failing.
  //   - A small TRICKLE of brand-new words keeps introducing the backlog,
  //     and the trickle shrinks when you're already drowning in failures.
  //   - An OCCASIONAL spaced check of a word you already know — only when one
  //     comes due (mastered words surface ~monthly, known ~biweekly, etc.).
  const failing = due.filter(w => {
    const lvl = w.masteryLevel || 0;
    return lvl >= 1 && lvl <= 2;           // STRUGGLING + LEARNING — priority
  });
  const fresh = due.filter(w => (w.masteryLevel || 0) === 0);   // never attempted
  const review = due.filter(w => (w.masteryLevel || 0) >= 3);   // known/mastered, due

  // New-word intake: ~30% of the session, dropping to ~20% then 1 as the
  // backlog of words you're failing grows. Always at least 1 so intake
  // never fully stalls (while fresh words remain).
  let newQuota = Math.max(1, Math.round(dailyCount * 0.3));
  if (failing.length >= dailyCount) newQuota = Math.max(1, Math.round(dailyCount * 0.2));
  if (failing.length >= dailyCount * 2) newQuota = 1;

  // Spaced review: ~10% of the session, but only if any known word is due.
  const reviewQuota = review.length > 0 ? Math.max(1, Math.round(dailyCount * 0.1)) : 0;

  let selected = [];
  const taken = new Set();
  const take = (pool, n) => {
    if (n <= 0 || pool.length === 0) return;
    const avail = pool.filter(w => !taken.has(w.rowNumber));
    if (avail.length === 0) return;
    const picked = weightedPick_(avail, Math.min(n, avail.length), words.length);
    picked.forEach(w => { selected.push(w); taken.add(w.rowNumber); });
  };

  // 1. The words you're failing fill most of the session.
  take(failing, dailyCount - newQuota - reviewQuota);
  // 2. A trickle of brand-new words.
  take(fresh, Math.min(newQuota, dailyCount - selected.length));
  // 3. An occasional check of something you already know.
  take(review, Math.min(reviewQuota, dailyCount - selected.length));

  // 4. Backfill unused slots: more failing, then more new, then more review.
  //    (e.g. once the failing backlog is cleared, new words flow in faster.)
  take(failing, dailyCount - selected.length);
  take(fresh, dailyCount - selected.length);
  take(review, dailyCount - selected.length);

  // 5. Last-resort: top up from all words if the due pool was too small.
  if (selected.length < dailyCount) {
    take(words, dailyCount - selected.length);
  }

  return selected.slice(0, dailyCount);
}

// -------------------------------------------------------------------------
// Answer parsing & correctness checking
// -------------------------------------------------------------------------

function splitAnswerVariants_(english) {
  return String(english || '')
    .split(/[;,/|]+|\s+-\s+|\s+–\s+|\s+—\s+/)
    .map(x => String(x || '').trim())
    .filter(Boolean);
}

function getPrimaryAnswer_(english) {
  const variants = splitAnswerVariants_(english);
  return variants.length > 0 ? variants[0] : String(english || '').trim();
}

function normalizeAnswer_(value) {
  let text = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’`´]/g, "'")
    .replace(/&/g, ' and ');
  text = text.replace(/'/g, '');
  text = text.replace(/[^a-z0-9\s]/g, ' ');
  let tokens = text.split(/\s+/).map(t => t.trim()).filter(Boolean);
  const ignored = new Set(['a', 'an', 'the', 'to']);
  tokens = tokens.filter(t => !ignored.has(t));
  return tokens.join(' ');
}

function getCorrectVariants_(english) {
  return splitAnswerVariants_(english).map(x => normalizeAnswer_(x)).filter(Boolean);
}

function isCorrectAnswer_(userAnswer, correctEnglish) {
  const norm = normalizeAnswer_(userAnswer);
  if (!norm || norm === 'forgot') return false;
  return getCorrectVariants_(correctEnglish).includes(norm);
}

// Parse numbered lines: "1. word", "2) word", "3 word", "4: word", etc.
// Any order, partial, gibberish all OK — we just take what we can.
function parseAnswers_(text, maxNumber) {
  const answers = {};
  const source = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d{1,3})\s*[\.\)\:\-—–]?\s*(.+?)\s*$/);
    if (!m) continue;
    const number = Number(m[1]);
    const answer = String(m[2] || '').trim();
    if (number >= 1 && number <= maxNumber && answer) answers[number] = answer;
  }
  return answers;
}

function intervalForLevel_(level) {
  // Spaced-repetition interval driven by mastery level.
  if (level <= 1) return 1;   // STRUGGLING / NEW — back asap
  if (level === 2) return 3;  // LEARNING
  if (level === 3) return 7;  // JUST KNOWN
  if (level === 4) return 14; // KNOWN
  return 30;                  // MASTERED
}

// -------------------------------------------------------------------------
// OpenAI: generate practice sentences
// -------------------------------------------------------------------------

function buildPracticePrompt_(practiceWords) {
  const payload = practiceWords.map((w, i) => ({
    exerciseNumber: i + 1,
    answer: w.practiceAnswer,
    russianMeaning: w.russian,
  }));

  return (
    'Create one English fill-in-the-blank sentence for each target item.\n' +
    'The learner must fill in the missing English word or phrase.\n\n' +
    'Each item includes a Russian translation (russianMeaning). It is the\n' +
    'AUTHORITATIVE definition of the intended sense of the English answer.\n' +
    'If the English word is polysemous, the sentence MUST reflect the meaning\n' +
    'given in russianMeaning, not any other dictionary sense.\n\n' +
    'Rules:\n' +
    '1. Output only a JSON array. No Markdown. No explanations.\n' +
    '2. Return items in exactly the same order as the input array.\n' +
    '3. Each object must have exactly these fields: exerciseNumber, answer, sentence.\n' +
    '4. Use the exact answer string from the input in the answer field.\n' +
    '5. Do not change form/tense, do not remove articles or "to".\n' +
    '6. Sentence must contain exactly one blank token: EXACTLY five underscores in a row: _____\n' +
    '7. Never use 3, 4, 6, or any other count of underscores. Always 5.\n' +
    '8. Do not reveal the answer anywhere inside the sentence.\n' +
    '9. The sentence context must unambiguously match russianMeaning.\n' +
    '   If russianMeaning lists several senses separated by "/" or ",",\n' +
    '   pick any ONE of them and build the sentence around that sense.\n' +
    '10. Sentences must be natural, simple, useful for practice.\n' +
    '11. Do not use Russian text, em dashes, or en dashes in the sentence field.\n\n' +
    'Example input item:\n' +
    '{"exerciseNumber":1,"answer":"face the music","russianMeaning":"расхлёбывать последствия"}\n' +
    'Example output:\n' +
    '[{"exerciseNumber":1,"answer":"face the music","sentence":"After making a mistake, he had to _____ and explain."}]\n\n' +
    'Target items:\n' +
    JSON.stringify(payload, null, 2)
  );
}

function callOpenAI_(prompt, expectedCount) {
  const apiKey = getProp('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');
  const model = getProp('OPENAI_MODEL') || 'gpt-4o-mini';

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.3,
      max_output_tokens: Math.max(1200, expectedCount * 180),
    }),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', options);
  const status = response.getResponseCode();
  const body = response.getContentText();
  log_('openai_http', `status=${status}`, `body_len=${body.length}`);
  if (status < 200 || status >= 300) throw new Error(`OpenAI ${status}: ${body}`);

  const data = JSON.parse(body);
  if (data.status && data.status !== 'completed') {
    const reason = (data.incomplete_details && data.incomplete_details.reason) || data.status;
    throw new Error(`OpenAI not completed: ${reason}`);
  }
  if (data.output_text && String(data.output_text).trim()) return data.output_text;

  if (data.output && Array.isArray(data.output)) {
    const parts = [];
    data.output.forEach(item => {
      if (item.content && Array.isArray(item.content)) {
        item.content.forEach(c => { if (c.text) parts.push(c.text); });
      }
    });
    if (parts.length > 0) return parts.join('\n');
  }
  throw new Error('Could not extract text from OpenAI response');
}

function extractJsonArray_(text) {
  let clean = String(text || '').trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON array in OpenAI response');
  return JSON.parse(clean.slice(start, end + 1));
}

// Accept any run of 3+ underscores; normalize to exactly `_____` for the
// downstream replace step. If the sentence has 0 or >1 blanks, use a
// placeholder so the rest of the pipeline doesn't fall apart.
function normalizeSentence_(rawSentence) {
  let s = String(rawSentence || '').trim().replace(/—/g, '-').replace(/–/g, '-').trim();
  const blanks = s.match(/_{3,}/g) || [];
  if (!s || blanks.length !== 1) return 'Please use _____ in this sentence.';
  return s.replace(/_{3,}/, '_____');
}

function shuffleArray_(items) {
  const r = items.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = r[i]; r[i] = r[j]; r[j] = tmp;
  }
  return r;
}

// -------------------------------------------------------------------------
// Message builders
// -------------------------------------------------------------------------

function buildSentenceWithBoldAnswer_(sentence, answer) {
  const safeAnswer = `<b>${escapeHtml_(answer)}</b>`;
  const safeSentence = escapeHtml_(sentence);
  if (/_{3,}/.test(safeSentence)) return safeSentence.replace(/_{3,}/, safeAnswer);
  return `${safeSentence} Answer: ${safeAnswer}`;
}

// Combined daily message: translations (in original order) + practice
// sentences (in shuffled order), with English answers under per-line
// <tg-spoiler> blocks next to each Russian translation.
function buildCombinedDailyMessage_(itemsByOriginal, itemsByPractice) {
  const dayNumber = getDayNumber_();
  let text = `Daily Words: Day ${dayNumber}\n\n`;

  itemsByOriginal.forEach((it, i) => {
    text += `${i + 1}. ${escapeHtml_(it.russian)} — <tg-spoiler>${escapeHtml_(it.practiceAnswer)}</tg-spoiler>\n`;
  });

  text += '\nPractice:\n\n';
  itemsByPractice.forEach((it, i) => {
    text += `${i + 1}. ${escapeHtml_(it.sentence)}\n`;
  });

  return text.trim();
}

// Build review: for each practice item, show sentence (with bold answer),
// user's answer, correct answer, Russian meaning. Missing answers → Not sent.
function buildReviewMessage_(items, answers) {
  const lines = ['📊 Review'];
  items.forEach((item, i) => {
    const num = i + 1;
    const wasSent = Object.prototype.hasOwnProperty.call(answers, num);
    const userAnswer = wasSent ? answers[num] : '';
    const isCorrect = wasSent && isCorrectAnswer_(userAnswer, item.english);

    const status = !wasSent ? '❌ Not sent' : (isCorrect ? '✅' : '❌');
    const safeUserAnswer = !wasSent ? '(not sent)' : (userAnswer || 'empty');
    const sentence = buildSentenceWithBoldAnswer_(item.sentence, item.practiceAnswer);

    lines.push(
      `\n${num}. ${status}\n` +
      `   Sentence: ${sentence}\n` +
      `   Your answer: ${escapeHtml_(safeUserAnswer)}\n` +
      `   Correct answer: ${escapeHtml_(item.practiceAnswer)}\n` +
      `   Meaning: ${escapeHtml_(item.russian)}`
    );
  });
  return lines.join('\n');
}

function buildOverallStats_(words) {
  const totalWords = words.length;
  const practicedWords = words.filter(w => w.shownCount > 0).length;
  const answeredWords = words.filter(w => (w.correctCount + w.wrongCount) > 0).length;

  // FIX: "known" = mastery_level >= 3. Doesn't flip on a single wrong
  // answer (level drops by 2 per wrong, so 2 wrongs needed to fall out).
  const knownWords = words.filter(w => (w.masteryLevel || 0) >= 3).length;
  const knownRate = answeredWords > 0 ? Math.round((knownWords / answeredWords) * 100) : 0;
  const coverage = totalWords > 0 ? Math.round((practicedWords / totalWords) * 100) : 0;

  // Distribution across mastery levels — shows where you're stuck.
  const levels = [0, 0, 0, 0, 0, 0];
  words.forEach(w => {
    const lvl = Math.max(0, Math.min(5, w.masteryLevel || 0));
    levels[lvl]++;
  });

  return (
    `📈 Overall Stats\n\n` +
    `Total words: ${totalWords}\n` +
    `Practiced words: ${practicedWords}\n` +
    `Answered words: ${answeredWords}\n` +
    `Known words: ${knownWords}\n\n` +
    `Known rate: ${knownRate}%\n` +
    `Coverage: ${coverage}%\n\n` +
    `Levels:\n` +
    `  L0 (new):        ${levels[0]}\n` +
    `  L1 (struggling): ${levels[1]}\n` +
    `  L2 (learning):   ${levels[2]}\n` +
    `  L3 (just known): ${levels[3]}\n` +
    `  L4 (known):      ${levels[4]}\n` +
    `  L5 (mastered):   ${levels[5]}`
  );
}

// -------------------------------------------------------------------------
// Start session: pick words, call GPT, build combined message, send, save.
// Auto-resets everything at the start so old state can't poison this run.
// -------------------------------------------------------------------------

function sendDailyWordsNow() { startDailySession_(); }
function sendDailyWordsCron() { startDailySession_(); }

function startDailySession_() {
  const t0 = Date.now();
  log_('startSession', 'BEGIN');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  log_('startSession', 'lock_acquired');

  try {
    // Auto-reset, in this strict order:
    //   1. Clear old session.
    //   2. Drop Telegram backlog (atomically kills queued retries of old
    //      updates so they can't sneak through after step 3).
    //   3. Reset LAST_UPDATE_ID (start dedup fresh for the new session).
    // Doing 2 BEFORE 3 closes the small window where a stale retry could
    // pass dedup right after we reset the counter.
    clearActiveSession_();
    log_('startSession', 'old_session_cleared');
    try {
      dropTelegramBacklog();
      log_('startSession', 'telegram_backlog_dropped');
    } catch (e) {
      log_('startSession_drop_backlog_failed', e.message);
    }
    deleteProp(CONFIG.PROP_LAST_UPDATE_ID);
    log_('startSession', 'last_update_id_reset');

    setupServiceHeaders();
    log_('startSession', 'service_headers_ready');

    const tLoad = Date.now();
    const { sheet, serviceSheet, words, serviceValues } = loadWords_();
    log_('startSession', `loadWords ${Date.now() - tLoad}ms`, `${words.length} valid words`);

    if (words.length === 0) {
      log_('startSession', 'ABORT no_words');
      sendTelegramMessageSafe_('No words found. Add words to columns B and C.');
      return;
    }

    const sessionId = `session_${Date.now()}`;
    const selected = selectDailyWords_(words);
    log_('startSession', `selected ${selected.length} words`, selected.map(w => w.english).join(' | '));

    if (selected.length === 0) {
      log_('startSession', 'ABORT no_words_selected');
      sendTelegramMessageSafe_('No words available right now.');
      return;
    }

    // Update shown_count etc. for the picked words.
    const today = today_();
    selected.forEach(w => {
      const s = serviceValues[w.serviceIndex];
      s[SERVICE.SHOWN_COUNT] = toNumber_(s[SERVICE.SHOWN_COUNT], 0) + 1;
      s[SERVICE.LAST_SHOWN] = today;
      s[SERVICE.LAST_SESSION_ID] = sessionId;
    });
    const tShown = Date.now();
    serviceSheet
      .getRange(CONFIG.FIRST_DATA_ROW, CONFIG.SERVICE_START_COL, serviceValues.length, CONFIG.SERVICE_COLS_COUNT)
      .setValues(serviceValues);
    log_('startSession', `wrote shown_count etc ${Date.now() - tShown}ms`);

    // Original-order + practice-order items.
    const itemsByOriginal = selected.map((w, i) => ({
      originalNumber: i + 1,
      rowNumber: w.rowNumber,
      english: w.english,
      practiceAnswer: getPrimaryAnswer_(w.english),
      russian: w.russian,
      sentence: '',
    }));

    const itemsByPractice = shuffleArray_(itemsByOriginal).map((it, i) => Object.assign({}, it, {
      practiceNumber: i + 1,
    }));
    log_('startSession', 'shuffled_for_practice', itemsByPractice.map(it => `${it.practiceNumber}:${it.practiceAnswer}`).join(' | '));

    // Call GPT.
    let generated = [];
    const tGpt = Date.now();
    try {
      const prompt = buildPracticePrompt_(itemsByPractice);
      log_('gpt_request', `${itemsByPractice.length} words`, `prompt_len=${prompt.length}, model=${getProp('OPENAI_MODEL') || 'gpt-4o-mini'}`);
      const rawText = callOpenAI_(prompt, itemsByPractice.length);
      log_('gpt_response', `${Date.now() - tGpt}ms`, `response_len=${rawText.length}`);
      generated = extractJsonArray_(rawText);
      log_('gpt_parsed', `${(generated || []).length} items extracted`);
    } catch (e) {
      log_('gpt_FAILED', `${Date.now() - tGpt}ms`, e.message);
      generated = itemsByPractice.map((_, i) => ({
        exerciseNumber: i + 1,
        sentence: 'GPT failed — use _____ in a sentence.',
      }));
    }

    // Attach sentences by exerciseNumber. Track how many fell back.
    const sentencesByNum = {};
    if (Array.isArray(generated)) {
      generated.forEach((g, i) => {
        const num = Number(g.exerciseNumber || (i + 1));
        sentencesByNum[num] = normalizeSentence_(g.sentence);
      });
    }
    let fallbackCount = 0;
    itemsByPractice.forEach((it, i) => {
      const got = sentencesByNum[i + 1];
      if (!got || got === 'Please use _____ in this sentence.') fallbackCount++;
      it.sentence = got || 'Please use _____ in this sentence.';
    });
    log_('sentences_attached', `${itemsByPractice.length - fallbackCount} OK, ${fallbackCount} fallback`);

    itemsByPractice.forEach(it => {
      const orig = itemsByOriginal.find(o => o.rowNumber === it.rowNumber);
      if (orig) orig.sentence = it.sentence;
    });

    // Save session.
    const session = {
      id: sessionId,
      phase: 'awaiting_reply',
      date: today,
      items: itemsByPractice.map(it => ({
        practiceNumber: it.practiceNumber,
        originalNumber: it.originalNumber,
        rowNumber: it.rowNumber,
        english: it.english,
        practiceAnswer: it.practiceAnswer,
        russian: it.russian,
        sentence: it.sentence,
      })),
    };
    setActiveSession_(session);
    log_('session_saved', session.id, `${session.items.length} items`);

    // Send combined message.
    const message = buildCombinedDailyMessage_(itemsByOriginal, itemsByPractice);
    log_('daily_build', `msg_len=${message.length}`);
    const tSend = Date.now();
    try {
      sendTelegramMessage_(message);
      log_('daily_sent', session.id, `sent ${Date.now() - tSend}ms`);
    } catch (e) {
      log_('daily_send_failed', e.message);
      sendTelegramMessageSafe_(stripHtml_(message), null, false);
    }

    // Drop any retries that piled up during the 10-15s of GPT + send work.
    try {
      dropTelegramBacklog();
      log_('startSession', 'backlog_dropped_after_send');
    } catch (e) {
      log_('startSession_drop_backlog_post_failed', e.message);
    }

    log_('startSession', `DONE total ${Date.now() - t0}ms`);
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------------------
// Manual resets
// -------------------------------------------------------------------------

function forceResetSession() {
  clearActiveSession_();
  deleteProp(CONFIG.PROP_LAST_UPDATE_ID);
  log_('forceResetSession', 'done');
  Logger.log('Session cleared, LAST_UPDATE_ID reset.');
}

// One-time repair after the selection redesign. Old logic left every word
// you failed at mastery_level 0 ("new"), so failures never entered the
// struggling pool. This reclassifies any ATTEMPTED word (shown_count > 0)
// that is still sitting at level 0:
//   - currently on a correct streak  → 2 (LEARNING)
//   - otherwise (last answer wrong)  → 1 (STRUGGLING)
// All repaired words become due today so they re-enter rotation immediately.
// Safe to run more than once; it only touches level-0 attempted rows.
function repairMasteryLevels() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Previous request still processing.');
  try {
    setupServiceHeaders();
    const { serviceSheet, words, serviceValues } = loadWords_();
    const today = today_();
    let fixed = 0;
    words.forEach(w => {
      const s = serviceValues[w.serviceIndex];
      const shown = toNumber_(s[SERVICE.SHOWN_COUNT], 0);
      const level = toNumber_(s[SERVICE.MASTERY_LEVEL], 0);
      if (shown > 0 && level === 0) {
        const streak = toNumber_(s[SERVICE.CORRECT_STREAK], 0);
        const newLevel = streak > 0 ? 2 : 1;
        s[SERVICE.MASTERY_LEVEL] = newLevel;
        s[SERVICE.INTERVAL_DAYS] = intervalForLevel_(newLevel);
        s[SERVICE.NEXT_DUE] = today;
        s[SERVICE.IS_KNOWN] = 0;
        fixed++;
      }
    });
    if (serviceValues.length > 0) {
      serviceSheet
        .getRange(CONFIG.FIRST_DATA_ROW, CONFIG.SERVICE_START_COL, serviceValues.length, CONFIG.SERVICE_COLS_COUNT)
        .setValues(serviceValues);
    }
    log_('repairMasteryLevels', `${fixed} words reclassified`);
    Logger.log(`repairMasteryLevels: ${fixed} attempted level-0 words moved to struggling/learning.`);
  } finally {
    lock.releaseLock();
  }
}

function resetLearningProgress() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Previous request still processing.');
  try {
    setupServiceHeaders();
    const { sheet, serviceSheet, words, serviceValues } = loadWords_();
    const today = today_();
    words.forEach(w => {
      const s = serviceValues[w.serviceIndex];
      s[SERVICE.SHOWN_COUNT] = 0;
      s[SERVICE.CORRECT_COUNT] = 0;
      s[SERVICE.WRONG_COUNT] = 0;
      s[SERVICE.LAST_SHOWN] = '';
      s[SERVICE.LAST_SESSION_ID] = '';
      s[SERVICE.NEXT_DUE] = today;
      s[SERVICE.CORRECT_STREAK] = 0;
      s[SERVICE.INTERVAL_DAYS] = 0;
      s[SERVICE.IS_KNOWN] = 0;
      s[SERVICE.MASTERY_LEVEL] = 0;
    });
    if (serviceValues.length > 0) {
      serviceSheet
        .getRange(CONFIG.FIRST_DATA_ROW, CONFIG.SERVICE_START_COL, serviceValues.length, CONFIG.SERVICE_COLS_COUNT)
        .setValues(serviceValues);
    }
    setProp(CONFIG.PROP_DAY_ZERO_DATE, today);
    clearActiveSession_();
    deleteProp(CONFIG.PROP_LAST_UPDATE_ID);
    sendTelegramMessageSafe_(`Learning progress reset.\nWords: ${words.length}\nDay zero: ${today}`);
    log_('resetLearningProgress', `${words.length} words`);
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------------------
// Handle user's single reply (Daily Words + Practice answers in one go)
// -------------------------------------------------------------------------

function handleReply_(message, chatId) {
  const t0 = Date.now();
  log_('reply', 'BEGIN', `text=${(message.text || '').slice(0, 100)}`);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    log_('reply', 'ABORT lock_failed_8s');
    sendTelegramMessageSafe_('Previous request still processing. Try again in a few seconds.', chatId);
    return;
  }
  log_('reply', 'lock_acquired');

  try {
    const session = getActiveSession_();
    if (!session || session.phase !== 'awaiting_reply') {
      log_('reply', 'ABORT no_active_session', session ? `phase=${session.phase}` : 'null');
      sendTelegramMessageSafe_('No active session. Run sendDailyWordsNow from the editor.', chatId);
      return;
    }
    log_('reply', 'session_loaded', `id=${session.id}, items=${(session.items || []).length}`);

    const items = session.items || [];
    const expectedCount = items.length;
    const answers = parseAnswers_(message.text, expectedCount);
    const parsedCount = Object.keys(answers).length;
    log_('reply_parsed', `${parsedCount}/${expectedCount}`, message.text.slice(0, 200));

    const tLoad = Date.now();
    const { sheet, serviceSheet, words, serviceValues } = loadWords_();
    log_('reply', `loadWords ${Date.now() - tLoad}ms`, `${words.length} words`);

    const today = today_();
    const wordByRow = {};
    words.forEach(w => { wordByRow[w.rowNumber] = w; });

    let correctCount = 0;
    let wrongCount = 0;
    let notSentCount = 0;

    items.forEach((item, i) => {
      const num = i + 1;
      const wasSent = Object.prototype.hasOwnProperty.call(answers, num);
      const userAnswer = wasSent ? answers[num] : '';
      const isCorrect = wasSent && isCorrectAnswer_(userAnswer, item.english);

      if (!wasSent) notSentCount++;
      else if (isCorrect) correctCount++;
      else wrongCount++;

      const serviceIndex = item.rowNumber - CONFIG.FIRST_DATA_ROW;
      const s = serviceValues[serviceIndex];
      if (!s) return;
      const word = wordByRow[item.rowNumber];

      const oldLevel = toNumber_(s[SERVICE.MASTERY_LEVEL], 0);
      if (isCorrect) {
        const newLevel = Math.min(5, oldLevel + 1);
        const newStreak = toNumber_(s[SERVICE.CORRECT_STREAK], 0) + 1;
        const newInterval = intervalForLevel_(newLevel);
        s[SERVICE.CORRECT_COUNT] = toNumber_(s[SERVICE.CORRECT_COUNT], 0) + 1;
        s[SERVICE.CORRECT_STREAK] = newStreak;
        s[SERVICE.MASTERY_LEVEL] = newLevel;
        s[SERVICE.INTERVAL_DAYS] = newInterval;
        s[SERVICE.NEXT_DUE] = addDays_(today, newInterval);
        s[SERVICE.IS_KNOWN] = newLevel >= 3 ? 1 : 0;
        if (word) {
          word.correctCount += 1; word.correctStreak = newStreak;
          word.masteryLevel = newLevel; word.isKnown = newLevel >= 3 ? 1 : 0;
        }
      } else {
        // Floor at 1, not 0: once a word has been attempted and failed it
        // becomes STRUGGLING, never "new" again. Level 0 strictly means
        // "never attempted". This is what feeds failures into the priority
        // pool instead of dumping them back among the unseen words.
        const newLevel = Math.max(1, oldLevel - 2);
        const newInterval = intervalForLevel_(newLevel);
        s[SERVICE.WRONG_COUNT] = toNumber_(s[SERVICE.WRONG_COUNT], 0) + 1;
        s[SERVICE.CORRECT_STREAK] = 0;
        s[SERVICE.MASTERY_LEVEL] = newLevel;
        s[SERVICE.INTERVAL_DAYS] = newInterval;
        s[SERVICE.NEXT_DUE] = addDays_(today, newInterval);
        s[SERVICE.IS_KNOWN] = newLevel >= 3 ? 1 : 0;
        if (word) {
          word.wrongCount += 1; word.correctStreak = 0;
          word.masteryLevel = newLevel; word.isKnown = newLevel >= 3 ? 1 : 0;
        }
      }
    });
    log_('reply_scored', `correct=${correctCount}, wrong=${wrongCount}, not_sent=${notSentCount}`);

    if (serviceValues.length > 0) {
      const tWrite = Date.now();
      serviceSheet
        .getRange(CONFIG.FIRST_DATA_ROW, CONFIG.SERVICE_START_COL, serviceValues.length, CONFIG.SERVICE_COLS_COUNT)
        .setValues(serviceValues);
      log_('reply', `wrote service sheet ${Date.now() - tWrite}ms`);
    }

    // Build combined Review + Stats.
    const tBuild = Date.now();
    const reviewBody = buildReviewMessage_(items, answers);
    const statsBody = buildOverallStats_(words);
    const combined = reviewBody + '\n\n' + statsBody;
    log_('reply', `built msg ${Date.now() - tBuild}ms`, `msg_len=${combined.length}`);

    // Reset session BEFORE sending so a Telegram retry can't reprocess.
    clearActiveSession_();
    log_('session_cleared_after_reply', session.id);

    const tSend = Date.now();
    try {
      sendTelegramMessage_(combined, chatId);
      log_('review_sent', session.id, `sent ${Date.now() - tSend}ms`);
    } catch (e) {
      log_('review_send_failed', e.message);
      sendTelegramMessageSafe_(stripHtml_(combined), chatId, false);
    }

    // Tell Telegram to drop retries of this user's reply.
    try {
      dropTelegramBacklog();
      log_('reply', 'backlog_dropped_after_review');
    } catch (e) {
      log_('drop_backlog_after_reply_failed', e.message);
    }

    log_('reply', `DONE total ${Date.now() - t0}ms`);
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------

function isCommand_(text, command) {
  const t = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  return t === command || t.startsWith(command + '@');
}

function handleWordsCommand_(text, chatId) {
  const parts = String(text || '').trim().split(/\s+/);
  const value = parts[1];
  if (!value) {
    sendTelegramMessageSafe_(
      `Current daily word count: ${getDailyWordsCount_()}\nUse /words 10 to change.`,
      chatId
    );
    return;
  }
  const count = Number(value);
  if (!Number.isFinite(count) || count < 1) {
    sendTelegramMessageSafe_(`Invalid. Use a number from 1 to ${CONFIG.MAX_DAILY_WORDS_COUNT}.`, chatId);
    return;
  }
  const saved = setDailyWordsCount_(count);
  sendTelegramMessageSafe_(`Daily word count is now ${saved}.`, chatId);
}

function handleStatsCommand_(chatId) {
  const { words } = loadWords_();
  sendTelegramMessageSafe_(buildOverallStats_(words), chatId);
}

function handleLogCommand_(chatId) {
  const wasEnabled = getProp('LOG_ENABLED') !== 'false';
  const newState = !wasEnabled;
  setProp('LOG_ENABLED', newState ? 'true' : 'false');
  _logEnabledCache = newState;
  sendTelegramMessageSafe_(
    newState ? '📝 Logging enabled.' : '🔇 Logging disabled.',
    chatId
  );
}

function handleDebugCommand_(chatId, messageId) {
  const session = getActiveSession_();
  if (!session) {
    sendTelegramMessageSafe_('Debug: no active session.', chatId);
    return;
  }
  sendTelegramMessageSafe_(
    `Debug:\n` +
    `phase: ${session.phase}\n` +
    `id: ${session.id}\n` +
    `items: ${(session.items || []).length}\n` +
    `incoming message_id: ${messageId}`,
    chatId
  );
}

// -------------------------------------------------------------------------
// Webhook entry
// -------------------------------------------------------------------------

function doGet(e) {
  return ContentService.createTextOutput('English Forge webhook is running.');
}

function doPost(e) {
  let chatId = null;

  try {
    const update = JSON.parse(e.postData.contents);
    const updateId = Number(update.update_id || 0);
    const message = update.message || {};
    const text = String(message.text || '');
    const messageId = Number(message.message_id || 0);
    chatId = message.chat && message.chat.id;

    // Dedup by Telegram's update_id BEFORE we log to sheet — otherwise every
    // single Telegram retry adds a doPost_enter row even though dedup will
    // immediately drop it. We want the sheet log to show only ACTUAL events.
    if (updateId) {
      const last = Number(getProp(CONFIG.PROP_LAST_UPDATE_ID) || 0);
      if (updateId <= last) {
        Logger.log(`doPost dedup: update_id=${updateId} <= last=${last}`);
        return ContentService.createTextOutput('ok');
      }
      setProp(CONFIG.PROP_LAST_UPDATE_ID, String(updateId));
    }

    // Now this is a fresh update — log it.
    log_('doPost_enter', `update_id=${updateId}, msg_id=${messageId}`, text.slice(0, 200));

    if (!update.message || !update.message.text) {
      log_('doPost_no_text', '');
      return ContentService.createTextOutput('ok');
    }

    const userId = message.from && message.from.id;
    const allowedUserId = Number(getProp('ALLOWED_USER_ID'));
    const groupChatId = Number(getProp('GROUP_CHAT_ID'));

    if (Number(chatId) !== groupChatId) {
      log_('doPost_wrong_chat', `chat=${chatId}, expected=${groupChatId}`);
      return ContentService.createTextOutput('ok');
    }
    if (Number(userId) !== allowedUserId) {
      log_('doPost_wrong_user', `user=${userId}, expected=${allowedUserId}`);
      return ContentService.createTextOutput('ok');
    }

    if (isCommand_(text, '/ping')) {
      log_('doPost_route', 'cmd_ping');
      sendTelegramMessageSafe_(`✅ English Forge is alive.\nchat: ${chatId}\nuser: ${userId}`, chatId);
      dropBacklogAfterCommand_('ping');
      return ContentService.createTextOutput('ok');
    }
    if (isCommand_(text, '/debug')) {
      log_('doPost_route', 'cmd_debug');
      handleDebugCommand_(chatId, messageId);
      dropBacklogAfterCommand_('debug');
      return ContentService.createTextOutput('ok');
    }
    if (isCommand_(text, '/stats')) {
      log_('doPost_route', 'cmd_stats');
      handleStatsCommand_(chatId);
      dropBacklogAfterCommand_('stats');
      return ContentService.createTextOutput('ok');
    }
    if (isCommand_(text, '/words')) {
      log_('doPost_route', 'cmd_words');
      handleWordsCommand_(text, chatId);
      dropBacklogAfterCommand_('words');
      return ContentService.createTextOutput('ok');
    }
    if (isCommand_(text, '/log')) {
      log_('doPost_route', 'cmd_log');
      handleLogCommand_(chatId);
      dropBacklogAfterCommand_('log');
      return ContentService.createTextOutput('ok');
    }

    log_('doPost_route', 'handleReply');
    handleReply_(message, chatId);
    // handleReply_ already drops backlog after sending review.
    return ContentService.createTextOutput('ok');

  } catch (error) {
    log_('doPost_FATAL', error && error.message, error && error.stack ? error.stack.slice(0, 500) : '');
    return ContentService.createTextOutput('ok');
  }
}

// -------------------------------------------------------------------------
// Testing helpers (run from editor)
// -------------------------------------------------------------------------

function testDoPostLocally() {
  const fakeUpdate = {
    update_id: Date.now(),
    message: {
      message_id: 999999,
      from: { id: Number(getProp('ALLOWED_USER_ID')) },
      chat: { id: Number(getProp('GROUP_CHAT_ID')) },
      date: Math.floor(Date.now() / 1000),
      text: '/ping',
    },
  };
  doPost({ postData: { contents: JSON.stringify(fakeUpdate) } });
}
