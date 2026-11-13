// ZCode Discord channel adapter (community enablement for the "Coming soon" tile).
//
// How it plugs into ZCode: the patch injected into out/host/index.js dynamically
// imports this module from inside the bot service factory and calls install(ctx).
// `ctx` carries the host's own internals:
//   ctx.setProvider(p)        -> registers the adapter into the provider map (Ye.discord)
//   ctx.readConfig()          -> reads bot-config.v3.json (BotsRepo.readConfig)
//   ctx.processProviderCallback("discord", payload) -> shared inbound pipeline
//   ctx.statusSink            -> runtime status shown in the Bots dialog
//   ctx.credentialService     -> safeStorage-backed credential store (unused here)
//
// Everything Discord-specific (gateway WebSocket, REST, token storage) lives here,
// inside the ZCode host process, so no HTTP port or public endpoint is needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOD_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(MOD_DIR, "tokens.json");
const COMMANDS_FILE = path.join(MOD_DIR, "commands.json");
const DM_FILE = path.join(MOD_DIR, "dm-channels.json");
const LOCK_FILE = path.join(MOD_DIR, "gateway.lock");
const API = "https://discord.com/api/v10";

// Direct Messages (1<<12) + Guild Messages (1<<9); both unprivileged.
// Message content in DMs and all interaction events arrive without privileged intents.
const INTENTS = (1 << 12) | (1 << 9);
const MAX_TEXT = 2000;

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}
function writeJson(p, v) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}
function log(ctx, msg) {
  try { ctx.logger.warn(void 0, "[zcode-discord] " + msg); } catch { console.warn("[zcode-discord]", msg); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tokenStore() { return readJson(TOKENS_FILE, { tokens: {} }); }
function setToken(botId, token) {
  const s = tokenStore();
  s.tokens[botId] = token;
  writeJson(TOKENS_FILE, s);
}
function tokenFor(bot) {
  const s = tokenStore();
  if (s.tokens[bot.id]) return s.tokens[bot.id];
  if (process.env.ZCODE_DISCORD_TOKEN) return process.env.ZCODE_DISCORD_TOKEN;
  // Single-token auto-adopt: if the config has exactly one discord bot and the
  // token store has exactly one entry, assume they belong together (e.g. bots
  // created from the patched UI dialog instead of register.mjs).
  return null;
}

let dmCache = readJson(DM_FILE, {});
function dmChannels(botId) { return (dmCache[botId] ||= {}); }
function rememberDm(botId, userId, channelId) {
  const m = dmChannels(botId);
  if (m[userId] !== channelId) { m[userId] = channelId; writeJson(DM_FILE, dmCache); }
}
function dmChannelKeyFromMessage(d) {
  // MESSAGE_CREATE in a DM: channel_id is the DM channel, author is the human.
  const isDm = d.channel_type === 1 || (d.guild_id == null && d.author && !d.author.bot);
  return isDm && d.channel_id && d.author?.id ? { userId: String(d.author.id), channelId: String(d.channel_id) } : null;
}

// ---------------------------------------------------------------- REST

async function rest(token, method, p, body, signal) {
  const res = await fetch(API + p, {
    method,
    headers: { authorization: "Bot " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(`Discord API ${method} ${p} -> HTTP ${res.status}: ${json?.message || res.statusText}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- selection callbacks
// Encode/decode mirrors ZCode's Telegram inline-keyboard scheme (buildSelectionCallbackData /
// decodeTelegramCallbackData) so the shared command pipeline handles button presses.

function selCustomId(sel, i) {
  const a = sel.action || "selection";
  if (a === "permission.respond") return `zc:permission:${i + 1}`;
  if (a === "elicitation.respond") return sel.token ? `zc:e:${sel.token}:${i + 1}` : `zc:elicitation:${i + 1}`;
  if (a === "model.provider.set") return `zc:cmd:/model provider ${i + 1}`;
  if (a === "model.set") return `zc:cmd:/model model ${i + 1}`;
  return `zc:${a.replace(".set", "")}:${i + 1}`;
}
function decodeCb(s) {
  if (s === "zc:cancel") return "/cancel";
  if (s.startsWith("zc:e:")) {
    const parts = s.split(":"); // zc e TOKEN IDX
    const token = parts[2], idx = parts[3];
    return token && idx ? `/elicitation ${token} ${idx}` : "/elicitation";
  }
  if (s.startsWith("zc:cmd:")) return s.slice(7);
  if (s.startsWith("zc:")) return "/" + s.slice(3).replace(":", " ");
  return s;
}

function splitText(text, limit) {
  const chunks = [];
  let rest = String(text ?? "");
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.4) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim() || chunks.length === 0) chunks.push(rest);
  return chunks;
}

// Small prompts (approve/deny style) render as buttons; anything list-like
// (models, workspaces, modes, …) renders as a native Discord select menu, which
// the user picks from a dropdown. Options beyond 25 are truncated (Discord cap).
function selectionComponents(sel) {
  const opts = Array.isArray(sel?.options) ? sel.options : [];
  if (!opts.length) return null;
  const items = opts.slice(0, 25).map((o, i) => ({
    label: String(o.label || o.value || `Option ${i + 1}`).slice(0, 100) || `Option ${i + 1}`,
    value: selCustomId(sel, i).slice(0, 100),
    ...(String(o.description || "").trim() ? { description: String(o.description).trim().slice(0, 100) } : {})
  }));
  const cancel = sel.showCancel !== false
    ? [{ type: 2, style: 2, label: String(sel.cancelLabel || "Cancel").slice(0, 80), custom_id: "zc:cancel" }]
    : [];
  const rows = [];
  if (opts.length <= 3) {
    const buttons = items.map(it => ({ type: 2, style: 2, label: it.label.slice(0, 80), custom_id: it.value }));
    for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
    if (cancel.length) rows.push({ type: 1, components: cancel });
  } else {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: "zc:select",
        placeholder: String(sel.placeholder || "Choose an option…").slice(0, 150),
        min_values: 1,
        max_values: 1,
        options: items
      }]
    });
    if (cancel.length) rows.push({ type: 1, components: cancel });
  }
  return rows.slice(0, 5);
}

// ---------------------------------------------------------------- slash commands

// Mirrors Telegram's syncCommands (setMyCommands): registers the host's command
// vocabulary with Discord so the slash-command picker autocompletes them.
// Names must match the host's splitCommand parser and Discord's lowercase rule.
function commandList(bot) {
  const allow = bot?.allowedCommands || {};
  const cmds = [
    { name: "bind", description: "Bind this chat to the workspace chosen in ZCode", options: [{ name: "code", description: "Bind code shown in ZCode > Bots", type: 3, required: true }] },
    { name: "help", description: "Show all ZCode bot commands" }
  ];
  const add = (name, description) => cmds.push({ name, description });
  if (allow.status !== false) add("status", "Show workspace, model and task status");
  if (allow.new !== false) add("new", "Start a new task draft");
  if (allow.workspace !== false) add("project", "Switch workspace");
  if (allow.model !== false) add("model", "Switch AI model");
  if (allow.mode !== false) add("mode", "Switch run mode");
  if (allow.thoughtLevel !== false) add("think", "Switch thought level");
  if (allow.reply !== false) add("reply", "Switch reply detail level");
  add("stop", "Stop the current task run");
  add("cancel", "Cancel the current selection or action");
  return cmds;
}

async function syncCommandsFor(ctx, mod, bot, token, appId) {
  const cmds = commandList(bot);
  const sig = JSON.stringify(cmds);
  const store = readJson(COMMANDS_FILE, {});
  if (store[bot.id] === sig) return false;
  let id = appId || mod.appIds?.[bot.id];
  if (!id) {
    const app = await rest(token, "GET", "/applications/@me").catch(() => null);
    if (app?.id) { id = String(app.id); (mod.appIds ||= {})[bot.id] = id; }
  }
  if (!id) return false;
  await rest(token, "PUT", `/applications/${id}/commands`, cmds);
  store[bot.id] = sig;
  writeJson(COMMANDS_FILE, store);
  log(ctx, `registered ${cmds.length} slash commands for bot=${bot.id} app=${id}`);
  return true;
}

// The host derives the reply recipient as `chatId ?? providerUserId` (see the
// makeReply helper in the host bundle): fine for Telegram where a private chat's
// chat_id IS the user id, but for Discord DMs chatId is the CHANNEL id. Map a
// known DM channel id back to its recipient user id so recipient lookups work.
function recipientFor(bot, target) {
  const t = String(target ?? "");
  const users = dmChannels(bot.id);
  if (users[t]) return t; // already a known recipient user id
  const uid = Object.keys(users).find(u => users[u] === t);
  if (uid) return uid; // host passed the DM channel id -> its recipient
  return t;
}

// ---------------------------------------------------------------- owner welcome DM

async function ensureDmChannel(bot, userId, token) {
  const cached = dmChannels(bot.id)[userId];
  if (cached) return cached;
  const ch = await rest(token, "POST", "/users/@me/channels", { recipient_id: userId });
  rememberDm(bot.id, userId, String(ch.id));
  return String(ch.id);
}

// Proactively open a DM with the application owner (or the owner of the first
// shared server) so the private chat appears in their DM list unprompted —
// matching the "open the bot and chat" feel of the Telegram flow. Retried until
// the bot actually shares a server with the owner (Discord requires it).
// Returns "sent" | "done" | "no-owner" | "cannot-dm".
async function ownerWelcomeDm(ctx, mod, bot, token) {
  const s = tokenStore();
  if (s.welcomed && s.welcomed[bot.id]) return "done";
  let ownerId = (mod.ownerIds ||= {})[bot.id] || null;
  if (!ownerId) {
    const app = await rest(token, "GET", "/applications/@me").catch(() => null);
    if (app?.owner?.id) ownerId = String(app.owner.id);
  }
  if (!ownerId) {
    const guilds = await rest(token, "GET", "/users/@me/guilds").catch(() => null);
    for (const g of guilds || []) {
      const info = await rest(token, "GET", `/guilds/${g.id}`).catch(() => null);
      if (info?.owner_id) { ownerId = String(info.owner_id); break; }
    }
  }
  if (!ownerId) return "no-owner";
  mod.ownerIds[bot.id] = ownerId;
  let ch = null;
  try {
    ch = await ensureDmChannel(bot, ownerId, token);
  } catch (e) {
    mod.lastWelcomeError = e?.message || String(e);
    return "cannot-dm";
  }
  await rest(token, "POST", `/channels/${ch}/messages`, {
    content: `✅ ZCode Discord bridge online. Open ZCode → Bots → the "${bot.name || bot.id}" card, copy the bind command, and paste it here (looks like \`/bind XXXXXXXX\`). Type \`/help\` for all commands.`
  });
  const s2 = tokenStore();
  (s2.welcomed ||= {})[bot.id] = ownerId;
  writeJson(TOKENS_FILE, s2);
  return "sent";
}

// ---------------------------------------------------------------- provider

function createProvider(ctx, mod) {
  async function tokenOf(bot) {
    const t = tokenFor(bot);
    return t && t.trim() ? t.trim() : null;
  }
  async function identify(bot) {
    const t = await tokenOf(bot);
    if (!t) throw new Error("Discord bot token is missing. Run register.mjs (see README).");
    return t;
  }
  async function resolveChannel(bot, userId) {
    const t = await identify(bot);
    return ensureDmChannel(bot, userId, t);
  }

  return {
    async test(bot) {
      const t = await tokenOf(bot);
      if (!t) return { ok: false, message: "Discord bot token is missing. Run register.mjs (see README)." };
      try {
        const me = await rest(t, "GET", "/users/@me");
        return { ok: true, name: me.username, message: "Discord bot is reachable." };
      } catch (e) {
        return { ok: false, message: "Discord bot check failed: " + e.message };
      }
    },
    async resolveName(bot) {
      const t = await tokenOf(bot);
      if (!t) return null;
      try { return (await rest(t, "GET", "/users/@me")).username || null; } catch { return null; }
    },
    async syncCommands(bot) {
      const t = await tokenOf(bot);
      if (!t) return;
      await syncCommandsFor(ctx, mod, bot, t).catch(e => log(ctx, `syncCommands bot=${bot?.id}: ${e?.message || e}`));
    },
    async send(bot, msg) {
      const t = await identify(bot);
      const userId = recipientFor(bot, msg.providerUserId);
      const channelId = await resolveChannel(bot, userId);
      const chunks = splitText(msg.text ?? "", MAX_TEXT);
      const components = selectionComponents(msg.selection);
      let lastId;
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const body = { content: chunks[i] || "\u200b" };
        if (isLast && components) body.components = components;
        const res = await rest(t, "POST", `/channels/${channelId}/messages`, body);
        lastId = res?.id != null ? String(res.id) : lastId;
      }
      return { providerMessageId: lastId };
    },
    async sendTyping(bot, target) {
      const t = await tokenOf(bot);
      if (!t) return;
      // Host passes {providerUserId: chatId ?? providerUserId} — may be a DM
      // channel id or a user id; resolve either to the DM channel.
      const raw = String(target?.providerUserId || target?.chatId || "");
      if (!raw) return;
      const users = dmChannels(bot.id);
      const channelId = Object.values(users).includes(raw) ? raw : users[recipientFor(bot, raw)];
      if (!channelId) return;
      await rest(t, "POST", `/channels/${channelId}/typing`, {}).catch(() => {});
    },
    async acknowledgeCallback(bot, raw, text, reply, signal) {
      // The quick ack on INTERACTION_CREATE deferred the interaction; now that
      // the answer has landed as a regular channel message, DELETE the
      // ephemeral "thinking" placeholder. Interaction webhook routes are TWO
      // segments — /webhooks/{application_id}/{interaction_token} — the token
      // itself encodes the interaction id; adding an id segment 404s. The host
      // aborts its own `signal` on a 3s ack budget, but this is best-effort
      // cleanup after the reply already landed, so use a fresh short-lived
      // signal instead of inheriting a stale abort.
      const d = raw?.update?.kind === "interaction" ? raw.update.data : null;
      if (!d?.token || !d?.id) return;
      const t = await tokenOf(bot);
      const id = String(d.id);
      const own = AbortSignal.timeout(4000);
      // Await an in-flight quickAck defer so cleanup never runs before the
      // placeholder exists; if it failed or never ran, defer here instead.
      const pending = mod.ackedInteractions?.get(id);
      mod.ackedInteractions?.delete(id);
      let deferred = pending ? await pending : false;
      if (!deferred) {
        await rest(t, "POST", `/interactions/${id}/${d.token}/callback`, { type: 5, data: { flags: 64, loading: true } }, own)
          .then(() => { deferred = true; }, e => {
            // "Unknown interaction" = already responded/deferred (duplicate
            // delivery raced us), which still leaves a placeholder to delete.
            const m = String(e?.message || e);
            if (m.includes("Unknown interaction")) deferred = true;
            else log(ctx, `fallback defer failed id=${id}: ${m}`);
          });
      }
      if (!deferred) return;
      let appId = mod.appIds?.[bot.id];
      if (!appId) {
        const app = await rest(t, "GET", "/applications/@me").catch(() => null);
        if (app?.id) { appId = String(app.id); (mod.appIds ||= {})[bot.id] = appId; }
      }
      if (!appId) return;
      // DELETE is the only thing that makes an ephemeral placeholder vanish —
      // PATCH-to-blank leaves a visible empty "Only you can see this" row.
      // Safe here because the reply went out through /channels/{id}/messages,
      // not as an interaction-webhook followup, so the ephemeral delete-cascade
      // has nothing of ours under this token to take with it. If DELETE fails
      // (token expires after 15 min), fall back to blanking.
      await rest(t, "DELETE", `/webhooks/${appId}/${d.token}/messages/@original`, undefined, own)
        .catch(() => rest(t, "PATCH", `/webhooks/${appId}/${d.token}/messages/@original`, { content: "​", components: [], flags: 64 }, own)
          .catch(e => log(ctx, `placeholder clear failed id=${id}: ${e?.message || e}`)));
    },
    async downloadAttachment() { return null; },
    async resolveActorDisplayName(bot, actor) {
      return mod.userNames?.[bot.id]?.[actor?.providerUserId] || null;
    },
    parseCallback(raw) {
      const botId = typeof raw?.botId === "string" ? raw.botId : "";
      const u = raw?.update || raw;
      if (!botId || !u) return [];
      if (u.kind === "message") {
        const d = u.data;
        if (!d || d.author?.bot || d.author?.system) return [];
        const isDm = d.channel_type === 1 || d.guild_id == null;
        if (!isDm) return []; // private MVP; group topics come later
        const text = typeof d.content === "string" ? d.content : "";
        const userId = d.author?.id != null ? String(d.author.id) : "";
        if (!userId) return [];
        if (d.channel_id) rememberDm(botId, userId, String(d.channel_id));
        const display = d.author.global_name || d.author.username;
        if (display) (mod.userNames[botId] ||= {})[userId] = display;
        if (!text.trim()) return [];
        return [{
          botId,
          text,
          actor: {
            provider: "discord",
            botId,
            providerUserId: userId,
            displayName: display,
            chatType: "private",
            chatId: d.channel_id != null ? String(d.channel_id) : undefined,
            providerMessageId: d.id != null ? String(d.id) : undefined
          }
        }];
      }
      if (u.kind === "interaction") {
        const d = u.data;
        if (!d) return [];
        let text = "";
        // Discord INTERACTION_CREATE types: 1=PING (never delivered to bots),
        // 2=ApplicationCommand, 3=MessageComponent (data.component_type:
        // 2=button, 3=string-select), 4=Autocomplete, 5=Modal.
        if (d.type === 2) {
          // Slash command from Discord's UI -> rebuild the textual command the
          // host's splitCommand parser expects ("/bind <code>", "/model", …).
          const name = typeof d.data?.name === "string" ? d.data.name : "";
          if (!name) return [];
          text = "/" + name;
          for (const o of Array.isArray(d.data?.options) ? d.data.options : []) {
            const v = o?.string_value ?? o?.integer_value ?? o?.number_value ??
              (typeof o?.boolean_value === "boolean" ? String(o.boolean_value) : o?.value);
            if (v !== undefined && v !== null && v !== "") text += " " + String(v);
          }
        } else if (d.type === 3 && d.data?.component_type === 2) {
          const cid = typeof d.data.custom_id === "string" ? d.data.custom_id : "";
          if (!cid.startsWith("zc:")) return [];
          text = decodeCb(cid);
        } else if (d.type === 3 && d.data?.component_type === 3) {
          // Select menu pick -> the chosen option's value carries the zc:* id.
          const cid = Array.isArray(d.data.values) && d.data.values.length ? String(d.data.values[0]) : "";
          if (!cid.startsWith("zc:")) return [];
          text = decodeCb(cid);
        } else {
          return [];
        }
        log(ctx, `interaction decoded id=${d.id} -> "${text}"`);
        const user = d.user || d.member?.user;
        const userId = user?.id != null ? String(user.id) : "";
        if (!userId) return [];
        if (d.channel_id) rememberDm(botId, userId, String(d.channel_id));
        const display = user.global_name || user.username;
        if (display) (mod.userNames[botId] ||= {})[userId] = display;
        return [{
          botId,
          text,
          actor: {
            provider: "discord",
            botId,
            providerUserId: userId,
            displayName: display,
            chatType: d.guild_id == null ? "private" : "group",
            chatId: d.channel_id != null ? String(d.channel_id) : undefined,
            providerMessageId: d.id != null ? String(d.id) : undefined
          }
        }];
      }
      return [];
    }
  };
}

// ---------------------------------------------------------------- gateway connection

function connectGateway(ctx, mod, bot, token) {
  const botId = bot.id;
  const st = (s, message, extra) => {
    try {
      ctx.statusSink.setRuntimeStatus({ botId, provider: "discord", status: s, message: message ?? `Discord ${s}.`, ...(extra || {}) });
    } catch { /* ignore */ }
  };
  let stopped = false, ws = null, hbTimer = null, awaitingAck = false;
  let seq = null, sessionId = null, resumeUrl = null;

  function cleanupSocket() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (ws) {
      const w = ws; ws = null;
      w.onmessage = w.onclose = w.onerror = w.onopen = null;
      try { w.close(); } catch { /* ignore */ }
    }
  }

  // Discord requires an interaction ACK within 3s, but the host's full pipeline
  // (binding, task RPCs, model lists) can exceed that — so defer immediately on
  // arrival and clear the "is thinking" placeholder later from
  // acknowledgeCallback(). Per the Discord docs this ACK must go to the
  // interaction *callback* endpoint (POST /interactions/{id}/{token}/callback);
  // POSTing to the webhook followup endpoint leaves the placeholder stuck on
  // "The application did not respond". The response must be type 5
  // (DEFERRED_CHANNEL_MESSAGE): type 6 is DEFERRED_UPDATE_MESSAGE for components
  // and does not show/clear a loading state. `loading` lives inside `data`
  // alongside the EPHEMERAL flag.
  async function quickAck(d) {
    if (!d || !d.id || !d.token) return;
    const k = String(d.id);
    const map = (mod.ackedInteractions ||= new Map());
    // Track the in-flight defer as a never-rejecting promise resolving to
    // whether the defer landed, so a very fast acknowledgeCallback can neither
    // double-defer nor edit/delete the placeholder before the defer exists.
    const p = rest(token, "POST", `/interactions/${d.id}/${d.token}/callback`, { type: 5, data: { flags: 64, loading: true } }, AbortSignal.timeout(2500))
      .then(() => true, e => {
        map.delete(k);
        log(ctx, `quickAck defer failed id=${d.id}: ${e?.message || e} — slow commands may show "did not respond"`);
        return false;
      });
    map.set(k, p);
  }

  async function welcomeLoop(who) {
    for (let i = 0; i < 20 && !stopped; i++) {
      let r = "error";
      try { r = await ownerWelcomeDm(ctx, mod, bot, token); } catch { /* retried below */ }
      if (r === "sent") { st("connected", `Discord gateway connected as @${who}; welcome DM sent.`); return; }
      if (r === "done") return;
      const why = r === "cannot-dm"
        ? (mod.lastWelcomeError || "cannot open DM") + " — invite the bot to a server you share with it"
        : "application owner not resolvable yet";
      st("connected", `Discord gateway connected as @${who}. Waiting to DM you: ${why} (retry every 15s).`);
      await sleep(15000);
    }
  }

  async function once() {
    const gwUrl = resumeUrl || (await rest(token, "GET", "/gateway")).url;
    const url = `${gwUrl}/?v=10&encoding=json`;
    return new Promise((resolve, reject) => {
      let opened = false;
      const w = new WebSocket(url);
      ws = w;
      const fail = (why) => { cleanupSocket(); reject(new Error(why)); };
      w.onopen = () => { opened = true; };
      w.onerror = () => { if (!opened) fail("gateway socket error"); };
      w.onclose = (ev) => {
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        ws = null;
        if (stopped) return resolve();
        // Keep seq/sessionId: attempt RESUME unless the close is fatal.
        if (ev.code === 4004 || ev.code === 4010 || ev.code === 4012 || ev.code === 4013 || ev.code === 4014) {
          sessionId = null; seq = null; resumeUrl = null;
        }
        if (ev.code === 4004) return reject(new Error("Discord authentication failed (bad token or intents)."));
        resolve();
      };
      w.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        const { op, d, s } = msg;
        if (s != null) seq = s;
        if (op === 10) {
          awaitingAck = false;
          if (hbTimer) clearInterval(hbTimer);
          hbTimer = setInterval(() => {
            if (!ws || ws.readyState !== 1) return;
            if (awaitingAck) {
              st("error", "Discord gateway heartbeat was not acknowledged; reconnecting.");
              try { ws.close(4000); } catch { /* ignore */ }
              return;
            }
            awaitingAck = true;
            try { ws.send(JSON.stringify({ op: 1, d: seq })); } catch { /* ignore */ }
          }, d.heartbeat_interval);
          if (sessionId != null && seq != null) {
            ws.send(JSON.stringify({ op: 6, d: { token, session_id: sessionId, seq } }));
          } else {
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token,
                intents: INTENTS,
                shard: [0, 1],
                properties: { os: "windows", browser: "zcode-discord", device: "zcode-discord" }
              }
            }));
          }
          return;
        }
        if (op === 11) { awaitingAck = false; return; }
        if (op === 1) return;
        if (op === 9) { sessionId = null; seq = null; try { ws.close(4000); } catch { /* ignore */ } return; }
        if (op === 7) { try { ws.close(1000); } catch { /* ignore */ } return; }
        if (op === 0) {
          const t = msg.t;
          if (t === "READY") {
            sessionId = d.session_id;
            resumeUrl = d.resume_gateway_url || resumeUrl;
            if (d.application?.id) (mod.appIds ||= {})[botId] = String(d.application.id);
            mod.connectedAt = Date.now();
            const who = d.user?.username || "?";
            st("connected", `Discord gateway connected as @${who}.`);
            void welcomeLoop(who);
            syncCommandsFor(ctx, mod, bot, token, d.application?.id ? String(d.application.id) : undefined)
              .catch(e => log(ctx, `slash command sync failed bot=${botId}: ${e?.message || e}`));
          } else if (t === "RESUMED") {
            st("connected", "Discord gateway reconnected (resumed).");
          } else if (t === "MESSAGE_CREATE") {
            handleEvent(ctx, botId, "message", d);
          } else if (t === "INTERACTION_CREATE") {
            log(ctx, `interaction received id=${d.id} type=${d.type} ${d.data?.name ? "slash /" + d.data.name : d.data?.custom_id ? "component " + String(d.data.custom_id).slice(0, 40) : "?"}`);
            void quickAck(d);
            handleEvent(ctx, botId, "interaction", d);
          }
        }
      };
    });
  }

  (async () => {
    let backoff = 1000;
    st("connecting", "Discord gateway connecting.");
    while (!stopped) {
      try {
        await once();
        backoff = 1000;
        if (stopped) break;
        st("connecting", "Discord gateway disconnected; reconnecting.");
      } catch (e) {
        if (stopped) break;
        st("error", "Discord gateway: " + (e?.message || e) + ` (retry in ${Math.round(backoff / 1000)}s)`);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
    st("idle", "Discord gateway stopped.");
  })();

  return {
    token,
    close(reason) { stopped = true; cleanupSocket(); void reason; }
  };
}

async function handleEvent(ctx, botId, kind, data) {
  try {
    await ctx.processProviderCallback("discord", { botId, update: { kind, data } });
  } catch (e) {
    log(ctx, `processProviderCallback(${kind}) failed bot=${botId}: ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------- runtime (self-reconciling poller)

// Only one host process may hold the gateway per token; a fresh lock owned by
// another process means "handled by another ZCode window".
function acquireLock() {
  const now = Date.now();
  const lk = readJson(LOCK_FILE, { pid: 0, ts: 0 });
  if (lk.pid && lk.pid !== process.pid && now - lk.ts < 15000) return false;
  writeJson(LOCK_FILE, { pid: process.pid, ts: now });
  return true;
}
function refreshLock() {
  try {
    const lk = readJson(LOCK_FILE, {});
    if (lk.pid === process.pid) writeJson(LOCK_FILE, { pid: process.pid, ts: Date.now() });
  } catch { /* ignore */ }
}
function releaseLock() {
  try {
    const lk = readJson(LOCK_FILE, {});
    if (lk.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch { /* ignore */ }
}

async function reconcile(ctx, mod) {
  if (mod.ackedInteractions?.size) {
    const cut = Date.now() - 18e5; // interaction tokens expire after 15 min
    for (const [k, ts] of mod.ackedInteractions) if (ts < cut) mod.ackedInteractions.delete(k);
  }
  let cfg = null;
  try { cfg = await ctx.readConfig(); } catch { return; }
  const discordBots = (cfg?.bots || []).filter(b => b.provider === "discord");
  const enabled = discordBots.filter(b => b.enabled);

  // single-token auto-adopt (see tokenFor)
  if (enabled.length) {
    const s = tokenStore();
    const have = Object.values(s.tokens).filter(Boolean);
    if (have.length === 1) {
      for (const b of enabled) {
        if (!s.tokens[b.id]) { s.tokens[b.id] = have[0]; writeJson(TOKENS_FILE, s); }
      }
    }
  }

  for (const [id, conn] of mod.conns) {
    const b = enabled.find(x => x.id === id);
    const tk = b ? tokenFor(b) : null;
    if (!b || !tk || conn.token !== tk) {
      conn.close("removed");
      mod.conns.delete(id);
      try {
        ctx.statusSink.setRuntimeStatus({ botId: id, provider: "discord", status: b ? "error" : "disabled", message: b ? "No Discord token — run register.mjs (see README)." : "Discord bot removed or disabled." });
      } catch { /* ignore */ }
    }
  }
  if (!enabled.length) { if (mod.lockHeld) { releaseLock(); mod.lockHeld = false; } return; }

  const wanted = new Set(enabled.map(b => b.id));
  const anyMissingToken = enabled.some(b => !tokenFor(b));
  if (!anyMissingToken && !mod.lockHeld && !acquireLock()) {
    for (const b of enabled) {
      try { ctx.statusSink.setRuntimeStatus({ botId: b.id, provider: "discord", status: "idle", message: "Discord gateway is held by another ZCode process." }); } catch { /* ignore */ }
    }
    return;
  }
  mod.lockHeld = mod.lockHeld || (!anyMissingToken && true);
  for (const b of enabled) {
    if (!wanted.has(b.id)) continue;
    const conn = mod.conns.get(b.id);
    if (conn) {
      // config may change between connects (allowedCommands) — cheap signature
      // check; the PUT only fires when the command list actually changed
      syncCommandsFor(ctx, mod, b, conn.token).catch(() => {});
      continue;
    }
    const tk = tokenFor(b);
    if (!tk) {
      try { ctx.statusSink.setRuntimeStatus({ botId: b.id, provider: "discord", status: "error", message: "No Discord token — run register.mjs (see README.md)." }); } catch { /* ignore */ }
      continue;
    }
    if (!mod.lockHeld) {
      try { ctx.statusSink.setRuntimeStatus({ botId: b.id, provider: "discord", status: "idle", message: "Discord gateway is held by another ZCode process." }); } catch { /* ignore */ }
      continue;
    }
    mod.conns.set(b.id, connectGateway(ctx, mod, b, tk));
  }
}

export function install(ctx) {
  const mod = { conns: new Map(), userNames: {}, appIds: {}, lockHeld: false };
  ctx.setProvider(createProvider(ctx, mod));
  const timer = setInterval(() => {
    reconcile(ctx, mod).catch(e => log(ctx, "reconcile failed: " + (e?.message || e)));
  }, 3000);
  const lockTimer = setInterval(() => { if (mod.lockHeld) refreshLock(); }, 5000);
  timer.unref?.(); lockTimer.unref?.();
  reconcile(ctx, mod).catch(e => log(ctx, "initial reconcile failed: " + (e?.message || e)));
  process.on("exit", releaseLock);
  log(ctx, "Discord channel module installed.");
}

export { setToken, tokenStore, MOD_DIR, selectionComponents, commandList };
