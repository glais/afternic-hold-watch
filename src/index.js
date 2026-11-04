/**
 * afternic-hold-watch
 * -------------------
 * A tiny Cloudflare Worker that watches your Afternic portfolio and sends you a
 * Telegram message the moment one of your domains changes to (or from) a given
 * listing status.
 *
 * By default it watches for `ON_HOLD`. On Afternic a listing goes ON_HOLD when a
 * sale or lease-to-own is in progress (pending transfer), so in practice this is a
 * near-real-time "one of my domains just sold / started leasing" alert.
 *
 * The Afternic Aftermarket Portfolio API has NO webhook, so we poll it on a cron
 * schedule and diff the set of watched-status domains against the previous run,
 * which is stored in Workers KV. Liveness is reported to Healthchecks.io so a
 * silently-dead Worker gets noticed.
 *
 * Everything is configured through environment variables / secrets — see README.
 */

const API_ROOT = "https://api.afternic.com/v3/aftermarket";

export default {
  /** Cron Trigger entry point (see `[triggers]` in wrangler.toml). */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, "cron"));
  },

  /**
   * HTTP entry point. Serves a small, secret-free status page so you can see the
   * Worker is alive, and (optionally) lets you trigger a poll by hand for testing.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Optional manual trigger for testing: only enabled if you set the
    // MANUAL_TRIGGER_TOKEN secret, and only when ?token= matches it.
    if (url.searchParams.get("run") === "1") {
      if (env.MANUAL_TRIGGER_TOKEN && url.searchParams.get("token") === env.MANUAL_TRIGGER_TOKEN) {
        const result = await runCheck(env, "manual");
        return json(result);
      }
      return json({ error: "Manual trigger disabled or bad token." }, 403);
    }

    const meta = (await kvGetJSON(env, "meta")) || {};
    const watching = (await kvGetJSON(env, "watched_set")) || null;
    return json({
      service: "afternic-hold-watch",
      watchStatus: env.WATCH_STATUS || "ON_HOLD",
      pollSchedule: "see wrangler.toml [triggers].crons",
      watchingCount: watching ? watching.length : null,
      watching: watching, // domains currently in the watched status
      lastRun: meta.lastRun || null,
      lastTrigger: meta.lastTrigger || null,
      lastResult: meta.lastResult || null,
    });
  },
};

/**
 * One polling cycle: guard -> fetch watched set -> diff vs KV -> notify -> persist.
 * Returns a small summary object (also stored in KV `meta` and shown on the status page).
 */
async function runCheck(env, trigger) {
  const watchStatus = env.WATCH_STATUS || "ON_HOLD";
  const notifyOnRelease = String(env.NOTIFY_ON_RELEASE || "false").toLowerCase() === "true";
  const enrich = String(env.ENRICH_WITH_SALE || "true").toLowerCase() === "true";

  // Fail loudly in logs if the essentials are missing.
  for (const key of ["AFTERNIC_API_KEY", "AFTERNIC_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!env[key]) {
      console.error(`Missing required secret: ${key}`);
      return { status: "misconfigured", missing: key };
    }
  }

  let result;
  try {
    // --- Blindness guard -------------------------------------------------
    // Confirm the API is actually answering sanely BEFORE we trust a result.
    // A blocked/broken poll and a genuinely-empty result look identical; without
    // this guard we could record hours of confident "nothing happened".
    const guard = await api(env, "/domains?limit=1");
    if (!guard || !Array.isArray(guard.domains) || typeof guard?.pagination?.total !== "number") {
      throw new Error("Guard check failed: unexpected /domains response shape");
    }

    // --- Current watched set --------------------------------------------
    const current = await fetchWatchedSet(env, watchStatus);

    // --- Previous set from KV -------------------------------------------
    const previousArr = await kvGetJSON(env, "watched_set");

    if (previousArr === null) {
      // First ever run: establish a baseline silently so pre-existing holds
      // don't fire as "just went on hold". Send one friendly startup note.
      await kvPutJSON(env, "watched_set", [...current].sort());
      await notify(env, startupMessage(watchStatus, current));
      result = { status: "bootstrap", watchingCount: current.size };
    } else {
      const previous = new Set(previousArr);
      const added = [...current].filter((d) => !previous.has(d)); // newly in status
      const removed = [...previous].filter((d) => !current.has(d)); // left the status

      for (const domain of added) {
        await notify(env, await enteredMessage(env, domain, watchStatus, enrich));
      }
      if (notifyOnRelease) {
        for (const domain of removed) {
          await notify(env, leftMessage(domain, watchStatus));
        }
      }

      await kvPutJSON(env, "watched_set", [...current].sort());
      result = { status: "ok", watchingCount: current.size, added, removed };
    }

    await healthcheck(env, "success");
  } catch (err) {
    console.error("Poll failed:", err && err.stack ? err.stack : String(err));
    // Do NOT update KV on failure — keep the last good baseline.
    await healthcheck(env, "fail");
    result = { status: "suspect", error: String(err && err.message ? err.message : err) };
  }

  // Record non-sensitive run metadata for the status page.
  await kvPutJSON(env, "meta", {
    lastRun: new Date().toISOString(),
    lastTrigger: trigger,
    lastResult: result,
  });
  return result;
}

/** Fetch every domain currently in `status`, following pagination. Returns a Set of names. */
async function fetchWatchedSet(env, status) {
  const names = new Set();
  const limit = 100; // API max per page
  let offset = 0;
  for (;;) {
    const body = await api(env, `/domains?listStatus=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`);
    for (const d of body.domains || []) names.add(d.name);
    const total = body?.pagination?.total ?? names.size;
    offset += limit;
    if (offset >= total || !(body.domains || []).length) break;
  }
  return names;
}

/** GET a path under the authenticated customer, with a small retry on 429/5xx. */
async function api(env, path) {
  const customer = env.CUSTOMER_ID || "my";
  const url = `${API_ROOT}/customers/${customer}${path}`;
  const headers = {
    Authorization: `sso-key ${env.AFTERNIC_API_KEY}:${env.AFTERNIC_API_SECRET}`,
    Accept: "application/json",
    "User-Agent": "afternic-hold-watch/1.0",
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    const retriable = res.status === 429 || res.status >= 500;
    lastErr = new Error(`HTTP ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    if (!retriable || attempt === 2) break;
    await sleep(500 * Math.pow(2, attempt));
  }
  throw lastErr;
}

/** Best-effort sale lookup to enrich an alert with price / sale type. Never throws. */
async function describeSale(env, domain) {
  try {
    const body = await api(env, `/sales?keyword=${encodeURIComponent(domain)}&limit=5`);
    const sales = (body.sales || []).filter((s) => (s.name || "").toLowerCase() === domain.toLowerCase());
    if (!sales.length) return null;
    sales.sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)));
    const s = sales[0];
    const price = usd(s.salePrice);
    if (s.saleType === "LEASED") {
      const perMo = usd(s.installmentAmount);
      const n = s.totalInstallments;
      return `Lease-to-own — ${price} total${n ? `, ${perMo}/mo × ${n}` : ""}`;
    }
    return `Buy Now — ${price}`;
  } catch (err) {
    console.error("Sale enrichment failed (non-fatal):", String(err));
    return null;
  }
}

// --- Message builders -------------------------------------------------------

function startupMessage(status, current) {
  const list = [...current].sort();
  const head = `👀 afternic-hold-watch is live. Watching listStatus=${status}.`;
  if (!list.length) return `${head}\nNothing is currently ${status}. You'll get a ping when something changes.`;
  return `${head}\nBaseline — ${list.length} already ${status} (won't re-alert):\n• ${list.join("\n• ")}`;
}

async function enteredMessage(env, domain, status, enrich) {
  let msg = `🔔 ${domain} → ${status}`;
  if (status === "ON_HOLD") msg += `\nLikely a sale or lease-to-own in progress.`;
  if (enrich) {
    const detail = await describeSale(env, domain);
    if (detail) msg += `\n${detail}`;
  }
  return msg;
}

function leftMessage(domain, status) {
  return `✅ ${domain} is no longer ${status} (deal completed, or fell through).`;
}

// --- Integrations -----------------------------------------------------------

/** Send a Telegram message. Logs (does not throw) on failure so one bad send can't abort the run. */
async function notify(env, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.error(`Telegram send failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error("Telegram send threw:", String(err));
  }
}

/** Ping Healthchecks.io (or any compatible URL). `state` is "success" or "fail". Optional. */
async function healthcheck(env, state) {
  if (!env.HEALTHCHECK_URL) return;
  const url = state === "fail" ? `${env.HEALTHCHECK_URL.replace(/\/$/, "")}/fail` : env.HEALTHCHECK_URL;
  try {
    await fetch(url, { method: "POST" });
  } catch (err) {
    console.error("Healthcheck ping failed:", String(err));
  }
}

// --- Tiny helpers -----------------------------------------------------------

/** All Afternic money fields are micro-units (millionths). 3950000000 -> "$3,950". */
function usd(micros) {
  const n = (Number(micros) || 0) / 1_000_000;
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function kvGetJSON(env, key) {
  return env.STATE ? env.STATE.get(key, "json") : null;
}
async function kvPutJSON(env, key, value) {
  if (env.STATE) await env.STATE.put(key, JSON.stringify(value));
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
