# English Forge

Telegram bot for training English vocabulary from a Google Sheet. Once a day (or on demand) it sends 5-10 words to translate + practice sentences, checks your answer, and tracks statistics and spaced repetition in the same sheet.

Architecture: **Google Sheets** stores the vocabulary and statistics, **Apps Script** runs the logic and talks to Telegram + OpenAI, **OpenAI** generates the practice sentences.

---

## Contents

1. [Prerequisites](#prerequisites)
2. [Setup from scratch](#setup-from-scratch)
3. [Bot commands](#bot-commands)
4. [Editor functions](#editor-functions)
5. [How word selection works](#how-word-selection-works)
6. [How practice sentences are generated](#how-practice-sentences-are-generated)
7. [Sheet structure](#sheet-structure)
8. [Script Properties](#script-properties)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Google account (for Sheets and Apps Script).
- Telegram account.
- Account at platform.openai.com with a funded balance (minimum $5).
- A word list in `english | russian` format, at least 50+ rows.

---

## Setup from scratch

### Step 1. Create a Telegram bot

1. Open **@BotFather** in Telegram.
2. Command:
   ```
   /newbot
   ```
3. Enter a name (for example `My Words Trainer`).
4. Enter a username (must end in `bot`, for example `my_words_trainer_bot`).
5. BotFather will send back the **TELEGRAM_TOKEN** like `1234567890:AAH...` - save it.
6. Disable privacy mode (so the bot can see messages in the group):
   ```
   /setprivacy
   ```
   Pick your bot -> **Disable**.

### Step 2. Create a group and add the bot

1. Create a regular Telegram group (or supergroup).
2. Add the bot to the group.
3. Make the bot an **admin** (messages are more reliable that way).
4. Type any message in the group, for example `/start@your_bot_username` - needed so Telegram registers the group for the bot.

### Step 3. Find GROUP_CHAT_ID and USER_ID

In a browser open (paste your token):
```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

In the JSON response look for:
- `"chat":{"id": -100...}` - this is your **GROUP_CHAT_ID** (typically a negative number starting with `-100`).
- `"from":{"id": ...}` - this is your **ALLOWED_USER_ID** (your Telegram user_id).

If the response is empty (`result: []`) - send another message in the group and repeat the request.

### Step 4. Get an OpenAI API key

1. Go to [platform.openai.com](https://platform.openai.com).
2. Log in, fund your balance via Billing (minimum $5).
3. API keys -> Create new secret key. Pick:
   - Name: `English Forge`
   - Permissions: `All`
4. Copy the key immediately (it's shown **only once**, starts with `sk-...`).

### Step 5. Create a Google Sheet with words

Create a new spreadsheet. The main sheet should have these columns:

| A (any) | B (english) | C (russian) | D (optional transcription, not used) |
|---|---|---|---|
| 1 | crucial | ключевой / крайне важный | /ˈkruːʃəl/ |
| 2 | to face the music | расхлёбывать последствия | |
| ... | ... | ... | |

**Important:** the `english` (B) and `russian` (C) columns are required. If a row is missing either - the bot ignores that row. Transcription in column D is for you, the bot does not read it.

Service columns (`shown_count`, `mastery_level`, etc.) the bot **creates itself** on a separate sheet `_service_cols` on first run. You don't need to add them.

### Step 6. Open Apps Script

In Google Sheets:
```
Extensions -> Apps Script
```

Delete whatever is there. Copy the entire content of `english project/english_forge_fixed.gs` from this project and paste it into the editor. Save (Ctrl+S or Cmd+S).

### Step 7. Add Script Properties

In Apps Script:
```
Project Settings (gear icon on the left) -> Script Properties -> Add script property
```

Add one by one:

| Property name | Value |
|---|---|
| `TELEGRAM_TOKEN` | token from BotFather (`1234...:AAH...`) |
| `ALLOWED_USER_ID` | your user_id (number) |
| `GROUP_CHAT_ID` | group id (for example `-1003783181152`) |
| `OPENAI_API_KEY` | OpenAI key (`sk-...`) |
| `OPENAI_MODEL` | `gpt-4o-mini` (or another model) |

Optional (defaults exist):

| Property | Default | Description |
|---|---|---|
| `DAILY_WORDS_COUNT` | `10` | how many words per session |
| `DAY_ZERO_DATE` | `2026-05-25` | start date for the `Day N` counter |
| `SHEET_NAME` | (auto) | name of the main word sheet; if not set - the bot takes the first visible one |
| `WEBHOOK_URL` | (auto) | deployment URL; used by `setWebhook` if set |

Save.

### Step 8. Deploy as a Web App

In Apps Script:
```
Deploy -> New deployment -> gear icon -> Web app
```

Settings:
- **Description:** `English Forge v1` (anything)
- **Execute as:** `Me`
- **Who has access:** **`Anyone`** <- critically important, otherwise Telegram will get 401/302

Click **Deploy**, grant the requested permissions (Allow -> Advanced -> Go to project (unsafe) -> Allow).

Copy the **Web app URL** (ends with `/exec`, not `/dev`!). Save it in Script Properties as `WEBHOOK_URL`.

### Step 9. Install the Telegram webhook

In the Apps Script editor:
1. From the function dropdown (top) pick **`setWebhook`**.
2. Click **Run**.
3. The Execution log should show a line like:
   ```
   setWebhook response (url=...): {"ok":true,"result":true,"description":"Webhook was set"}
   ```

To verify: pick **`diagnoseWebhook`** -> Run. The log will show a JSON with `url`, `pending_update_count: 0`, no `last_error_message`.

### Step 10. First test

In the group chat type:
```
/ping
```

The bot should reply:
```
✅ English Forge is alive.
chat: -100...
user: ...
```

If it replied - good, the foundation works. If silent - see [Troubleshooting](#troubleshooting).

### Step 11. Run the first session

In the Apps Script editor pick **`sendDailyWordsNow`** -> Run.

This automatically:
1. Clears the Telegram backlog.
2. Creates the `_service_cols`, `_english_forge_state`, `_english_forge_log` sheets (if missing).
3. Initializes service columns for all your words (mastery_level = 0 for new ones, or migrates from existing data if you had an older schema).
4. Picks 10 words via the algorithm.
5. Shuffles them and asks GPT to generate practice sentences (~5-10 seconds). The prompt sends each English word together with its Russian translation from the sheet - GPT treats the translation as the authoritative meaning, so for polysemous words it picks the exact sense you are learning.
6. Sends one big combined message to the Telegram group:
   - List of 10 Russian translations in original order.
   - Each with the English answer hidden under a `<tg-spoiler>` (tapping reveals only that one spoiler).
   - List of 10 practice sentences with `_____` blanks in **shuffled** order.

### Step 12. Reply and Review

You reply in the chat with one message - a numbered list of answers **in practice order** (i.e. answer Practice #1, then #2, etc.):

```
1. emergency fund
2. light up like fairgrounds
3. confabulation
4. in essence
5. ideation
6. ...
```

Parsing rules are loose:
- You can answer **in any order**: `3. word`, then `1. word`, then `5. word`.
- You can **skip numbers** - skipped ones become `❌ Not sent`.
- You can send **anything** even `xyz` - the bot will build a Review with 0 correct.
- The only thing that matters is that you actually send a message to the group.

A few seconds later the bot sends **Review + Overall Stats** as one message:
- For each practice line: the sentence with the correct word filled in (bold), your answer, the correct answer, and the meaning.
- The distribution of words across levels `L0-L5`.

After that the session is automatically cleared, and the next `sendDailyWordsNow` (or cron) will start a new one.

### Step 13. (Optional) Daily trigger

In Apps Script:
```
Triggers (clock icon on the left) -> Add Trigger
```

Settings:
- **Function to run:** `sendDailyWordsCron`
- **Event source:** Time-driven
- **Type of time-based trigger:** Day timer
- **Time of day:** for example `09:00 - 10:00`

Save. From this moment on, the bot will send a new session every day at the chosen time.

---

## Bot commands

All commands are sent in the chat of the group the bot is in.

| Command | What it does |
|---|---|
| `/ping` | Checks the bot is alive, returns chat_id and user_id. |
| `/stats` | Overall Stats: total/practiced/answered/known + distribution across levels L0-L5. |
| `/debug` | Current session state (phase, id, items count). |
| `/words` | Show current daily word count. |
| `/words 15` | Change daily word count (1 to 50). |
| `/log` | Toggle logging (turn on/off writing to `_english_forge_log`). |

---

## Editor functions

Run from Apps Script (pick the function at the top -> Run).

| Function | Purpose |
|---|---|
| `sendDailyWordsNow` | Start a session right now (same as `sendDailyWordsCron`, just convenient from the editor). |
| `sendDailyWordsCron` | The one you put in the daily trigger. |
| `forceResetSession` | Clear the active session + reset LAST_UPDATE_ID. Does NOT touch stats. |
| `resetLearningProgress` | **Wipe ALL progress**: shown/correct/wrong/mastery_level -> 0 for every word. DAY_ZERO_DATE = today. Clears the session. |
| `repairMasteryLevels` | **One-time migration** after the selection redesign. Moves already-shown words stuck at `mastery_level = 0` into STRUGGLING/LEARNING and makes them due today. Run once. Safe to re-run. |
| `setWebhook` | Set the Telegram webhook to the current deployment. Auto-detects URL from `WEBHOOK_URL` property or `ScriptApp.getService().getUrl()`. |
| `dropTelegramBacklog` | Clear the Telegram retry queue (without changing the webhook URL). |
| `diagnoseWebhook` | Print `getWebhookInfo` to the log (URL, pending_update_count, last_error). |
| `testDoPostLocally` | Run a fake `/ping` update through `doPost` locally (no Telegram involved). |
| `setupServiceHeaders` | Force-write the headers into `_service_cols`. |

---

## How word selection works

Every word has a **mastery_level** from 0 to 5:

| Level | Status | When shown again |
|---|---|---|
| **0** | NEW - never shown | tomorrow |
| **1** | STRUGGLING - tried, failing | tomorrow |
| **2** | LEARNING - starting to stick | in 3 days |
| **3** | JUST KNOWN - first crossed the threshold | in 7 days |
| **4** | KNOWN - stably remembered | in 14 days |
| **5** | MASTERED - long-term memory | in 30 days |

### Level transitions

- **Correct answer:** level `+1` (capped at 5).
- **Wrong answer:** level `-2`, but **floored at 1** (not 0).

The floor of 1 is the key point: once a word has been attempted, it is never "new" again. **Level 0 strictly means "never shown".** Fail a new word and it immediately becomes STRUGGLING (1) and enters the priority pool, instead of falling back into the pile of unseen words.

This means:
- Word at level 5, missed once -> dropped to 3 (still KNOWN).
- Missed twice in a row -> dropped to 1 (STRUGGLING, falls out of known).
- New word (0) failed -> becomes 1 (STRUGGLING).
- Keep failing the same word -> it sticks at 1 (does not grow without bound) until you get it right. Selection is plastic: learn it -> level rises -> it shows up less often.

### Weights for weighted random

In each session the bot first filters out words that are "due" today (`next_due <= today`), then computes the weight for each:

```
base = 1
+ mastery_level bonus (the main signal is the plastic level, not an error counter):
    L0 -> +4   (new words; actual intake is throttled by a quota, not by weight)
    L1 -> +12  <- highest priority (words you keep failing)
    L2 -> +7
    L3 -> +2
    L4 -> +1
    L5 -> 0
+ days_since bonus (+1/+2/+3/+4 for 3/7/14/30 days since last shown)
    ONLY for words with a non-empty last_shown - i.e. actually shown before.
    Never-seen words do NOT get this bonus (otherwise hundreds of new words
    would outweigh real failures).
+ scale = 1 + dailyCount/20 (multiplier for L-bonuses and days bonuses)
```

From each pool, the needed number of words is picked randomly, proportional to weight.

### Session composition (quotas)

Instead of a lottery over the whole vocabulary, a session is assembled by quotas so the bulk is words you're failing, new words trickle in, and known words occasionally come back as a check:

1. **Bulk = the words you're failing** (L1-L2).
2. **New words - intake ~30%**, dropping to ~20% when `failing >= dailyCount` and to 1 when `failing >= dailyCount * 2` (big backlog -> fewer new words, so you clear it instead of drowning). At least 1 while new words remain.
3. **Review of known words - ~10%**, only if some L3+ word has come due (`next_due`).
4. Unused slots are backfilled: more failing -> more new -> more review. Once the backlog is cleared, new words flow in faster.
5. Last resort (the due pool is too small) - top up from all words.

---

## How practice sentences are generated

Once the words for a session are picked, the bot builds a JSON payload and sends it to OpenAI in one request. Each item carries three fields:

- `exerciseNumber` - position in the batch,
- `answer` - the English word/phrase from column B,
- `russianMeaning` - the Russian translation from column C.

The prompt declares `russianMeaning` to be the **authoritative definition** of the sense the learner is practicing. This matters for polysemous words: e.g. `face` can mean "лицо" or "столкнуться с / расхлёбывать". Without the translation GPT would pick a sense on its own, and the resulting sentence might drift to a meaning you are not learning.

If column C lists multiple senses separated by `/` or `,` (for example, `ключевой / крайне важный`), GPT is instructed to pick **one** of them and build the sentence around that single sense, instead of trying to cover all of them at once.

GPT returns a JSON array; each item carries the same `exerciseNumber`, the same `answer`, and a generated `sentence` with a `_____` blank. If JSON parsing fails or the model returns something off, the specific line falls back to `Please use _____ in this sentence.` and the rest of the session continues normally.

---

## Sheet structure

On first run of `sendDailyWordsNow`, three internal sheets are auto-created:

### Main sheet (yours, with the words)

| B | C |
|---|---|
| english | russian |

The first visible sheet in the spreadsheet (excluding internal ones) is used. Or you can specify it via the `SHEET_NAME` property.

### `_service_cols` (auto-created)

10 columns. Row N matches row N of the main sheet:

| A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|
| shown_count | correct_count | wrong_count | last_shown | last_session_id | next_due | correct_streak | interval_days | is_known | mastery_level |

- `mastery_level` (0-5) - the main mastery indicator.
- `is_known` - derived: `1` if `mastery_level >= 3`, else `0`.
- The rest - per-word stats.

If the main row has no english/russian but `_service_cols` still has numbers, the bot **auto-clears the orphan row** on the next run.

### `_english_forge_state` (hidden)

Stores the active session (JSON) - which words were shown, which answers we're waiting for, what phase. Auto-cleared after Review.

### `_english_forge_log`

Detailed activity log. Each row has timestamp, event type (kind), and details. Written events include:
- `doPost_enter` - webhook handler entered.
- `startSession`, `gpt_request`, `gpt_response`, `session_saved`, `daily_sent` - session steps.
- `reply_parsed`, `reply_scored`, `review_sent` - reply processing steps.
- `*_FAILED`, `*_FATAL` - errors.

You can turn logging off via the `/log` command (`LOG_ENABLED` property = `false`).

---

## Script Properties

### Required

| Property | Value |
|---|---|
| `TELEGRAM_TOKEN` | bot token from BotFather |
| `ALLOWED_USER_ID` | your Telegram user_id (only your messages are accepted) |
| `GROUP_CHAT_ID` | Telegram group id (starts with `-100...`) |
| `OPENAI_API_KEY` | OpenAI key |
| `WEBHOOK_URL` | deployment `/exec` URL (used by `setWebhook`) |

### Optional

| Property | Default | What |
|---|---|---|
| `OPENAI_MODEL` | `gpt-4o-mini` | model used to generate sentences |
| `DAILY_WORDS_COUNT` | `10` | words per session |
| `DAY_ZERO_DATE` | `2026-05-25` | the reference date for `Day N` |
| `SHEET_NAME` | (auto) | name of the words sheet |
| `LOG_ENABLED` | `true` | whether to write to `_english_forge_log` |

### Internal (the bot manages these, don't touch by hand)

| Property | What |
|---|---|
| `LAST_UPDATE_ID` | dedup for Telegram webhook retries |

### Deprecated (safe to delete if left over from older versions)

`ACTIVE_SESSION`, `LAST_DAILY_DATE`, `PRACTICE_CHAT_ID`, `PRACTICE_SESSION_ID` - no longer used.

---

## Troubleshooting

### The bot doesn't reply in the chat

1. Run `diagnoseWebhook` in the editor. Look at:
   - `url` should end with `/exec`. If it ends with `/dev` - that's the dev URL, Telegram can't reach it. Set `WEBHOOK_URL` to the correct `/exec` URL and run `setWebhook` again.
   - `pending_update_count > 0` or a `last_error_message` is present - the webhook is being rejected. Most common cause: in Deploy -> Manage deployments the **Who has access** setting is "Only myself" or "Anyone with Google account" - it needs to be `Anyone`. Do **Edit -> New version -> Anyone -> Deploy**.
2. Run `testDoPostLocally` - this synthetically invokes `doPost` with a `/ping`. If the chat shows `✅ English Forge is alive` - the code works, the issue is in the webhook setup.

### The bot replies to an old message of yours, not the new one

That's Telegram retrying a webhook that got stuck in its queue. Run `dropTelegramBacklog` once - the queue gets cleared. After that, new sessions automatically clear the queue on start and after each Review.

### "Practice scheduled..." arrived but Practice never came

Shouldn't happen in the current version (GPT is called synchronously inside `startDailySession_`, not via a trigger). If it still does - check `_english_forge_log` for `gpt_FAILED` or `daily_send_failed` with the error text.

### `OPENAI_API_KEY is not set` in the logs

Check Script Properties - the key should be in the `sk-...` (or `sk-proj-...`) format. And your OpenAI balance must be positive.

### `Telegram send failed: ... bot is not a member of the channel chat ...`

The bot isn't in the group or got removed. Add it back, make it an admin.

### I want to wipe everything and start over

Run `resetLearningProgress` from the editor. This zeros out all stats, mastery_level and DAY_ZERO_DATE. Words on the main sheet stay untouched.

If you want an even more complete reset - delete the `_service_cols` sheet from the Sheets UI. On the next `sendDailyWordsNow` it'll be created from scratch.

### I don't want log spam

Send `/log` in the chat - writing to `_english_forge_log` turns off. Send `/log` again - turns on. State is stored in the `LOG_ENABLED` property.

### How much does OpenAI cost

Each session does one request to `gpt-4o-mini` of about ~1500-2000 input tokens + ~500-1000 output. At current prices that's well under $0.001 per session. $5 will last several years of daily use.
