#!/usr/bin/env node
// Register a Discord bot with the patched ZCode Bots system.
//
//   node register.mjs --token <BOT_TOKEN> [--name "My ZCode"] [--workspace C:\path\to\project]...
//   node register.mjs --set-token <BOT_ID> --token <NEW_TOKEN>
//   node register.mjs --unregister <BOT_ID>
//
// Writes the bot entry into ~/.zcode/v2/bot-config.v3.json (validating the token
// against Discord first) and keeps the token in this folder's tokens.json.
// Run while ZCode is closed; start ZCode afterwards, DM the bot, and send
//   /bind <code>   (bind code shown on the bot card in ZCode > Bots)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const ZCODE_V2 = path.join(os.homedir(), ".zcode", "v2");
const CONFIG_FILE = path.join(ZCODE_V2, "bot-config.v3.json");
const STATE_FILE = path.join(ZCODE_V2, "bot-state.v3.json");
const MOD_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const TOKENS_FILE = path.join(MOD_DIR, "tokens.json");
const API = "https://discord.com/api/v10";

function parseArgs(argv) {
  const args = { workspaces: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token") args.token = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--bot-id") args.botId = argv[++i];
    else if (a === "--workspace") args.workspaces.push(argv[++i]);
    else if (a === "--set-token") args.setToken = argv[++i];
    else if (a === "--unregister") args.unregister = argv[++i];
    else if (a === "--reply-mode") args.replyMode = argv[++i];
    else throw new Error("Unknown argument: " + a);
  }
  return args;
}

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}
function backup(p) {
  if (fs.existsSync(p) && !fs.existsSync(p + ".bak-discord")) fs.copyFileSync(p, p + ".bak-discord");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg || cfg.version !== 3 || !Array.isArray(cfg.bots)) {
    throw new Error(`Unexpected bot config at ${CONFIG_FILE} — refusing to edit. ZCode must have run at least once.`);
  }
  const tokens = readJson(TOKENS_FILE, { tokens: {} });

  if (args.unregister) {
    const id = args.unregister;
    cfg.bots = cfg.bots.filter(b => b.id !== id);
    backup(CONFIG_FILE);
    writeJson(CONFIG_FILE, cfg);
    const state = readJson(STATE_FILE, null);
    if (state?.bots?.[id]) { backup(STATE_FILE); delete state.bots[id]; writeJson(STATE_FILE, state); }
    delete tokens.tokens[id];
    writeJson(TOKENS_FILE, tokens);
    console.log(`Unregistered discord bot "${id}". Restart ZCode to apply.`);
    return;
  }

  if (args.setToken) {
    if (!args.token) throw new Error("--token is required with --set-token");
    if (!cfg.bots.some(b => b.id === args.setToken)) throw new Error(`No bot with id "${args.setToken}" in ${CONFIG_FILE}`);
    const me = await verify(args.token);
    tokens.tokens[args.setToken] = args.token;
    writeJson(TOKENS_FILE, tokens);
    console.log(`Token for bot "${args.setToken}" updated (bot user: @${me.username}). Restart ZCode to apply.`);
    return;
  }

  if (!args.token) throw new Error("--token <BOT_TOKEN> is required (see README.md for creating a Discord bot).");
  const me = await verify(args.token);
  const botId = args.botId || `discord-${me.id}`;
  if (cfg.bots.some(b => b.id === botId)) throw new Error(`Bot id "${botId}" already exists in ${CONFIG_FILE}. Use --bot-id or --unregister first.`);

  const entry = {
    id: botId,
    name: args.name || `Discord ${me.username}`,
    provider: "discord",
    enabled: true,
    allowedWorkspaces: args.workspaces,
    allowedCommands: { status: true, new: true, workspace: true, model: true, thoughtLevel: true, reply: true },
    currentOptions: {},
    replyMode: args.replyMode || "assistant_changes"
  };
  cfg.bots.push(entry);
  backup(CONFIG_FILE);
  writeJson(CONFIG_FILE, cfg);
  tokens.tokens[botId] = args.token;
  writeJson(TOKENS_FILE, tokens);

  console.log(`Registered discord bot "${botId}" (@${me.username}).`);
  console.log(`  config: ${CONFIG_FILE}`);
  console.log(`  token : ${TOKENS_FILE}`);
  if (!args.workspaces.length) {
    console.log(`  NOTE: no --workspace given. Allow workspaces later in ZCode > Bots > ${entry.name},`);
    console.log(`        or rerun with --workspace "C:\\path\\to\\project".`);
  }
  console.log(`Next: make sure ZCode is patched (apply-discord-patch.bat), start ZCode, DM the bot,`);
  console.log(`      then open the bot card in ZCode > Bots, copy the bind command and send it in the DM.`);
}

async function verify(token) {
  const res = await fetch(API + "/users/@me", { headers: { authorization: "Bot " + token } });
  if (!res.ok) throw new Error(`Discord rejected the token (HTTP ${res.status}). Check the bot token at discord.com/developers/applications.`);
  return res.json();
}

main().catch(e => { console.error("register.mjs: " + e.message); process.exit(1); });
