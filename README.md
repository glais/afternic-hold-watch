# afternic-hold-watch

Get a **Telegram ping the moment one of your Afternic domains goes on hold** — which,
on Afternic, almost always means **a sale or lease-to-own just started**.

It's a single [Cloudflare Worker](https://developers.cloudflare.com/workers/) that polls
the [Afternic Aftermarket Portfolio API](https://api.afternic.com/docs/portfolio-api/)
on a schedule, notices when a domain enters (or leaves) a listing status, and messages
you on Telegram. It runs entirely within Cloudflare's **free tier — $0/month** — and needs
no server of your own.

```
┌───────────────┐   every 5 min    ┌──────────────────┐   diff vs.   ┌───────────┐
│ Cloudflare    │ ───────────────▶ │ Afternic         │   last run   │ Workers   │
│ Cron Trigger  │                  │ Portfolio API    │ ◀──────────▶ │ KV (state)│
└───────────────┘                  └──────────────────┘              └───────────┘
                                            │ new/removed domains
                                            ▼
                                   ┌──────────────────┐        ┌──────────────────┐
                                   │ Telegram alert    │        │ Healthchecks.io   │
                                   │ to your phone     │        │ (dead-man switch) │
                                   └──────────────────┘        └──────────────────┘
```

> **Why polling and not a webhook?** The Afternic API doesn't offer webhooks or any
> push mechanism, so there's nothing to subscribe to — polling is the only option. A
> hold typically lasts hours-to-days (pending transfer), so a 5-minute poll catches it
> reliably while staying trivially cheap.

---

## Contents

- [What counts as "on hold"](#what-counts-as-on-hold)
- [Cost](#cost)
- [What you'll need](#what-youll-need)
- [Setup, step by step](#setup-step-by-step)
  - [1. Get your Afternic API credentials](#1-get-your-afternic-api-credentials)
  - [2. Create a Telegram bot and find your chat ID](#2-create-a-telegram-bot-and-find-your-chat-id)
  - [3. (Recommended) Create a dead-man's switch](#3-recommended-create-a-dead-mans-switch)
  - [4. Clone and install](#4-clone-and-install)
  - [5. Create the KV namespace](#5-create-the-kv-namespace)
  - [6. Set your secrets](#6-set-your-secrets)
  - [7. Deploy](#7-deploy)
  - [8. Test it](#8-test-it)
- [Configuration reference](#configuration-reference)
- [How it stays reliable](#how-it-stays-reliable)
- [Troubleshooting](#troubleshooting)
- [Local development](#local-development)
- [License](#license)

---

## What counts as "on hold"

Every domain the API returns carries a `listStatus` field. Common values are
`ACTIVE`, `ON_HOLD`, and `SOLD`. A listing flips to **`ON_HOLD`** when there's a
transaction in flight on it (a Buy Now purchase or a lease-to-own kicking off),
pending the transfer completing. That's why watching for `ON_HOLD` works as a
"something just sold" alarm.

By default this tool watches `ON_HOLD`, but you can point it at any status via the
`WATCH_STATUS` variable — e.g. set it to `SOLD` to be told when deals complete.

---

## Cost

At the default 5-minute interval (288 runs/day), everything sits far inside Cloudflare's
free limits:

| Resource                     | Free limit        | This tool uses        |
| ---------------------------- | ----------------- | --------------------- |
| Worker invocations / day     | 100,000           | ~288                  |
| CPU time / invocation        | 10 ms             | ~1 ms                 |
| KV reads / day               | 100,000           | ~288–576              |
| KV writes / day              | 1,000             | only when things change |
| KV storage                   | 1 GB              | a few hundred bytes   |

Telegram and Healthchecks.io are both free too. **Net cost: $0.** (If you lower the
interval to every minute, only write KV on change — writing every minute would exceed
the 1,000 writes/day free cap. At 5 minutes it's a non-issue.)

---

## What you'll need

- A **Cloudflare account** (free) — <https://dash.cloudflare.com/sign-up>
- **Node.js 18+** installed locally (to run `wrangler`, Cloudflare's CLI)
- An **Afternic seller account** with Portfolio API access (an API key + secret)
- The **Telegram** app on your phone
- *(Optional, recommended)* a free **Healthchecks.io** account

---

## Setup, step by step

### 1. Get your Afternic API credentials

The Afternic Portfolio API uses GoDaddy-style **`sso-key`** credentials: an **API key**
and an **API secret**. Generate them from your Afternic account's API settings and keep
them somewhere safe. The official docs (including a live request playground to confirm
your keys work) are here:

➡️ <https://api.afternic.com/docs/portfolio-api/>

Quick sanity check from your terminal (replace `KEY`/`SECRET`):

```bash
curl -s 'https://api.afternic.com/v3/aftermarket/customers/my/domains?limit=1' \
  -H 'Authorization: sso-key KEY:SECRET'
```

A JSON response with a `domains` array and a `pagination.total` means you're good.

### 2. Create a Telegram bot and find your chat ID

**Create the bot:**

1. In Telegram, open a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts (pick a name and a username ending in `bot`).
3. BotFather replies with a **token** like `123456789:AAH...`. That's your `TELEGRAM_BOT_TOKEN`.

**Start a chat with your new bot** — open it and press **Start** (or send any message).
A bot cannot message you until you've messaged it first.

**Find your chat ID** (the easy way):

- Open a chat with **[@userinfobot](https://t.me/userinfobot)** and press Start — it
  replies with your numeric **Id**. That's your `TELEGRAM_CHAT_ID`.

Or, the API way — after messaging your bot, visit this URL in a browser (paste your token):

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

and read `result[].message.chat.id` from the JSON.

> Want alerts in a group instead? Add the bot to the group, send a message there, and
> use the group's chat ID (it's negative, e.g. `-100...`).

### 3. (Recommended) Create a dead-man's switch

A scheduled job that dies quietly looks exactly like "nothing happened". A
[Healthchecks.io](https://healthchecks.io) check fixes that: the Worker pings it on every
successful run, and if the pings stop arriving, Healthchecks emails/alerts **you**.

1. Sign up (free) and create a new **Check**.
2. Set the **period** to match your schedule (e.g. 5 minutes) with a little grace (e.g. 15 minutes).
3. Copy its **ping URL** (looks like `https://hc-ping.com/<uuid>`). That's your `HEALTHCHECK_URL`.

Skip this if you want, but you'll have no warning if the Worker stops.

### 4. Clone and install

```bash
git clone https://github.com/glais/afternic-hold-watch.git
cd afternic-hold-watch
npm install
```

Log `wrangler` into your Cloudflare account (opens a browser once):

```bash
npx wrangler login
```

### 5. Create the KV namespace

This is where the tool remembers which domains were on hold last time.

```bash
npx wrangler kv namespace create STATE
```

It prints something like:

```
[[kv_namespaces]]
binding = "STATE"
id = "a1b2c3d4e5f6...."
```

Copy that **`id`** into `wrangler.toml`, replacing `PASTE_YOUR_KV_NAMESPACE_ID_HERE`.

### 6. Set your secrets

Run each command and paste the value when prompted (these are encrypted by Cloudflare and
never stored in your repo):

```bash
npx wrangler secret put AFTERNIC_API_KEY
npx wrangler secret put AFTERNIC_API_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put HEALTHCHECK_URL       # optional, from step 3
npx wrangler secret put MANUAL_TRIGGER_TOKEN  # optional, any random string — enables ?run=1 testing
```

### 7. Deploy

```bash
npm run deploy
```

That's it — the Worker is live and the cron trigger is scheduled. On its **first run** it
quietly records which of your domains are already on hold (so it won't false-alarm about
pre-existing ones) and sends you a short "monitoring is live" message.

### 8. Test it

- **Visit the Worker URL** that `deploy` printed — you'll get a small JSON status page
  showing what it's watching and when it last ran.
- **Trigger a poll by hand** (if you set `MANUAL_TRIGGER_TOKEN`):

  ```
  https://afternic-hold-watch.<your-subdomain>.workers.dev/?run=1&token=YOUR_TOKEN
  ```

- **Watch live logs** as the cron fires:

  ```bash
  npm run tail
  ```

---

## Configuration reference

**Variables** (in `wrangler.toml`, under `[vars]` — safe to commit, re-deploy to change):

| Variable            | Default   | Meaning                                                             |
| ------------------- | --------- | ------------------------------------------------------------------- |
| `WATCH_STATUS`      | `ON_HOLD` | Which `listStatus` to watch (`ON_HOLD`, `SOLD`, `ACTIVE`, …).        |
| `NOTIFY_ON_RELEASE` | `false`   | Also alert when a domain **leaves** the watched status.             |
| `ENRICH_WITH_SALE`  | `true`    | Look up the sale to add price / Buy-Now-vs-lease detail to alerts.  |
| `CUSTOMER_ID`       | `my`      | `my` = the authenticated account. Leave as-is normally.             |

**Secrets** (set with `wrangler secret put` — never in the repo):

| Secret                  | Required | Meaning                                              |
| ----------------------- | -------- | ---------------------------------------------------- |
| `AFTERNIC_API_KEY`      | ✅       | Afternic API key.                                    |
| `AFTERNIC_API_SECRET`   | ✅       | Afternic API secret.                                 |
| `TELEGRAM_BOT_TOKEN`    | ✅       | From @BotFather.                                     |
| `TELEGRAM_CHAT_ID`      | ✅       | Where to send alerts.                                |
| `HEALTHCHECK_URL`       | ⬜       | Dead-man's-switch ping URL (Healthchecks.io).        |
| `MANUAL_TRIGGER_TOKEN`  | ⬜       | Enables the `?run=1&token=…` manual test trigger.    |

**Polling interval:** edit `crons` in `wrangler.toml` (`[triggers]`). Minimum is 1 minute;
`*/5 * * * *` is every 5 minutes.

---

## How it stays reliable

Two safeguards, because a monitor you can't trust is worse than none:

- **Blindness guard.** Each run first confirms the API is actually answering with a
  well-formed response before trusting the result. A blocked or broken poll and a genuinely
  empty result look identical — without this check the tool could record hours of confident
  "nothing happened". If the guard fails, the run is treated as *suspect*: it does **not**
  overwrite the saved baseline and it pings the dead-man's switch's `/fail` endpoint instead
  of success.
- **Dead-man's switch.** Even a managed cron can stop silently (Worker deleted, account
  issue, or the handler throwing every time). Cloudflare's free plan won't proactively tell
  you. The Healthchecks.io ping is what turns that silence into an alert.

---

## Troubleshooting

- **No Telegram messages arrive.** Did you press **Start** on your bot (step 2)? A bot
  can't DM you until you've messaged it. Double-check `TELEGRAM_CHAT_ID`. Run `npm run tail`
  and look for `Telegram send failed` lines.
- **`HTTP 401`/`403` from Afternic.** Your API key/secret is wrong or lacks Portfolio API
  access. Re-test with the `curl` command in step 1.
- **`HTTP 400 VALIDATION_ERROR` mentioning `limit`.** The API caps `limit` at 100 (its docs
  say 1000 — that's wrong). This tool already uses 100; don't raise it.
- **First run alerted me about domains already on hold.** It shouldn't — the first run sets
  a silent baseline. If you reset KV, the next run re-baselines silently again.
- **I want to re-baseline.** Delete the stored state:
  `npx wrangler kv key delete --binding STATE watched_set`.

---

## Local development

```bash
cp .dev.vars.example .dev.vars    # fill in your real values; .dev.vars is git-ignored
npm run dev:scheduled             # runs wrangler dev with scheduled-event testing
# in another terminal, fire the cron handler on demand:
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

---

## License

[MIT](./LICENSE). Contributions welcome — open an issue or PR.

---

*This project is not affiliated with or endorsed by Afternic or GoDaddy. "Afternic" is a
trademark of its owner; it's named here only to describe what the tool talks to.*
