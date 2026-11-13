#!/usr/bin/env node
// Enables the Discord channel in the ZCode desktop app by patching app.asar:
//   1. host/index.js      : inject a bootstrap that loads ~/.zcode/zcode-discord/adapter.mjs
//                           into the bot service (registers the discord provider + runtime),
//                           and add "discord" to the private-sync/binding provider list.
//   2. renderer styles-*  : flip the Discord tile from implemented:!1 to !0.
//   3. renderer IntlProvider-* (best-effort): update the "not available yet" texts.
//
//   node patch-zcode-asar.mjs            # check + apply (ZCode must be closed)
//   node patch-zcode-asar.mjs --check    # only verify anchors / current state
//   node patch-zcode-asar.mjs --restore  # restore the original app.asar backup
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RESOURCES = process.env.ZCODE_RESOURCES ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "ZCode", "resources");
const ASAR = path.join(RESOURCES, "app.asar");
const BACKUP = path.join(RESOURCES, "app.asar.pre-discord-patch.bak");
const MOD_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, "/");

const mode = process.argv[2] || "apply";

// ---------------------------------------------------------------- asar reader

function openAsar(file) {
  const fd = fs.openSync(file, "r");
  function readFully(buf, len, pos) {
    let d = 0;
    while (d < len) {
      const r = fs.readSync(fd, buf, d, len - d, pos + d);
      if (r <= 0) throw new Error("short read at " + pos);
      d += r;
    }
  }
  const head = Buffer.alloc(16);
  readFully(head, 16, 0);
  const headerTotal = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  readFully(jb, jsonLen, 16);
  const header = JSON.parse(jb.toString("utf8"));
  const base = 8 + headerTotal;
  function walk(n, p, out) {
    for (const k of Object.keys(n.files || {})) {
      const c = n.files[k];
      const cp = p + "/" + k;
      if (c.size) out.push({ path: cp, node: c });
      walk(c, cp, out);
    }
  }
  const entries = [];
  walk(header, "", entries);
  return { fd, header, base, entries, readFully, close: () => fs.closeSync(fd) };
}

// ---------------------------------------------------------------- patches

function hostBootstrap() {
  // Single statement appended after the third provider-runtime factory in bF.
  // In-scope identifiers at the insertion point: e (service deps), n (BotsRepo),
  // Ye (provider map), $t (status sink), mn (bots logger), zg (processProviderCallback).
  return ';import(process.env.ZCODE_DISCORD_MODULE||"file:///' + MOD_DIR +
    '/adapter.mjs").then(m=>m.install({setProvider:p=>{Ye.discord=p},getProvider:()=>Ye.discord,credentialService:e.credentialService,readConfig:()=>n.readConfig(),processProviderCallback:(w,b)=>zg(w,b),statusSink:$t,logger:mn,runBackgroundTasks:t})).catch(er=>{try{mn.warn(void 0,"[zcode-discord] load failed: "+(er&&er.message||String(er)))}catch(_){}});';
}

// Matches the injected bootstrap statement (any folder) between its two host
// anchors, so it can be rewritten when the module folder moves (re-clone /
// relocation). Anchoring on the patch anchors instead of the statement's inner
// shape means the pattern survives edits to hostBootstrap() itself.
const BOOT_LEFT = "processProviderCallback:zg});";
const BOOT_RIGHT = "async function F(w){";
const BOOT_RE = new RegExp(
  BOOT_LEFT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + BOOT_RIGHT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
);

function hostPatches() {
  return [
    {
      id: "host-bootstrap",
      marker: "ZCODE_DISCORD_MODULE",
      search: 'processProviderCallback:zg});async function F(w){',
      replace: 'processProviderCallback:zg});' + hostBootstrap() + 'async function F(w){'
    },
    {
      id: "host-private-sync-list",
      marker: '"telegram","weixin","discord"]',
      search: 'return["feishu","lark","telegram","weixin"].includes(w.provider)}',
      replace: 'return["feishu","lark","telegram","weixin","discord"].includes(w.provider)}'
    }
  ];
}
function rendererPatches() {
  return [
    {
      id: "renderer-tile-discord",
      marker: '{id:`discord`,label:`Discord`,implemented:!0}',
      search: '{id:`discord`,label:`Discord`,implemented:!1}',
      replace: '{id:`discord`,label:`Discord`,implemented:!0}',
      fileHint: "styles"
    },
    {
      id: "renderer-desc-en",
      optional: true,
      marker: "register.mjs",
      search: '"bots.newBot.providerDescription.discord":`Discord bot integration is planned.`',
      replace: '"bots.newBot.providerDescription.discord":`Create a bot, then bind by message. Token is set up via ~/.zcode/zcode-discord/register.mjs.`',
      fileHint: "IntlProvider"
    },
    {
      id: "renderer-settings-en",
      optional: true,
      marker: "gateway module",
      search: '"bots.providerSettings.discord":`Discord support is not available yet.`',
      replace: '"bots.providerSettings.discord":`Discord is enabled by the local gateway module in ~/.zcode/zcode-discord.`',
      fileHint: "IntlProvider"
    },
    {
      id: "renderer-settings-zh",
      optional: true,
      marker: "网关模块",
      search: '"bots.providerSettings.discord":`Discord 暂未开放配置。`',
      replace: '"bots.providerSettings.discord":`Discord 由 ~/.zcode/zcode-discord 本地网关模块提供。`',
      fileHint: "IntlProvider"
    }
  ];
}

function applyPatch(text, p) {
  if (text.includes(p.marker) && !text.includes(p.search)) return { text, status: "already" };
  const count = text.split(p.search).length - 1;
  if (count === 0) return { text, status: p.optional ? "missing-optional" : "anchor-missing" };
  if (count > 1) return { text, status: "anchor-ambiguous" };
  return { text: text.split(p.search).join(p.replace), status: "applied" };
}

// ---------------------------------------------------------------- asar writer

function pad4(n) { return Math.ceil(n / 4) * 4; }

// Rebuild the tree with recomputed offsets and an ordered data plan that mirrors
// the original traversal order (packed files stream in this exact order).
function buildPlan(src, patched) {
  const newHeader = JSON.parse(JSON.stringify(src.header));
  const plan = [];
  let off = 0;
  (function assign(node, p) {
    for (const k of Object.keys(node.files || {})) {
      const c = node.files[k];
      const cp = p + "/" + k;
      if (c.files) { assign(c, cp); continue; }
      if (c.unpacked || !c.size || Object.prototype.hasOwnProperty.call(c, "link")) continue;
      const buf = patched.get(cp);
      const size = buf ? buf.length : c.size;
      plan.push({ path: cp, origOffset: parseInt(c.offset || "0", 10), size, buf });
      c.offset = String(off);
      c.size = size;
      delete c.integrity;
      off += size;
    }
  })(newHeader, "");
  return { newHeader, plan };
}

function writeAsar(src, newHeader, plan, tmpOut) {
  const jsonBuf = Buffer.from(JSON.stringify(newHeader), "utf8");
  const padded = pad4(16 + jsonBuf.length);
  const headerFrame = Buffer.alloc(padded);
  // Chromium pickle framing used by asar:
  //   [0]=4  [4]=second-pickle total size (=padded-8)  [8]=second-pickle payload size
  //   [12]=json byte length  [16]=json bytes ... padded with zeros to `padded`
  headerFrame.writeUInt32LE(4, 0);
  headerFrame.writeUInt32LE(padded - 8, 4);
  headerFrame.writeUInt32LE(4 + pad4(jsonBuf.length), 8);
  headerFrame.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerFrame, 16);
  const out = fs.openSync(tmpOut, "w");
  try {
    let pos = 0;
    let w = 0;
    while (w < headerFrame.length) w += fs.writeSync(out, headerFrame, w, headerFrame.length - w, pos + w);
    pos += headerFrame.length;
    const chunk = Buffer.alloc(1 << 22);
    for (const e of plan) {
      if (e.buf) {
        let w2 = 0;
        while (w2 < e.buf.length) w2 += fs.writeSync(out, e.buf, w2, e.buf.length - w2, pos + w2);
        pos += e.buf.length;
        continue;
      }
      let read = 0;
      while (read < e.size) {
        const want = Math.min(chunk.length, e.size - read);
        const r = fs.readSync(src.fd, chunk, 0, want, src.base + e.origOffset);
        if (r <= 0) throw new Error("short read for " + e.path);
        let w2 = 0;
        while (w2 < r) w2 += fs.writeSync(out, chunk, w2, r - w2, pos + read + w2);
        read += r;
      }
      pos += e.size;
    }
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
}

function syntaxCheck(label, content) {
  const tmp = path.join(os.tmpdir(), "zcode-discord-check-" + label.replace(/\W/g, "_") + ".mjs");
  fs.writeFileSync(tmp, content);
  const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error("Syntax check failed for patched " + label + ":\n" + (r.stderr || r.stdout));
}

function zcodeRunning() {
  try {
    const out = execSync("tasklist /FI \"IMAGENAME eq ZCode.exe\" /NH", { encoding: "utf8" });
    return /ZCode\.exe/i.test(out);
  } catch { return false; }
}

// ---------------------------------------------------------------- main

function main() {
  if (!fs.existsSync(ASAR)) throw new Error("app.asar not found at " + ASAR);

  if (mode === "--restore") {
    if (!fs.existsSync(BACKUP)) throw new Error("No backup at " + BACKUP);
    if (zcodeRunning()) throw new Error("Close ZCode before restoring.");
    fs.rmSync(ASAR, { force: true });
    fs.copyFileSync(BACKUP, ASAR);
    console.log("Restored original app.asar from " + BACKUP);
    return;
  }

  const src = openAsar(ASAR);
  try {
    const hostEntry = src.entries.find(e => e.path === "/out/host/index.js");
    if (!hostEntry) throw new Error("/out/host/index.js missing from asar — app layout changed?");
    const hostBuf = Buffer.alloc(hostEntry.node.size);
    src.readFully(hostBuf, hostEntry.node.size, src.base + parseInt(hostEntry.node.offset, 10));
    const hostText = hostBuf.toString("utf8");

    const rendererEntries = src.entries.filter(e => /^\/out\/renderer\/assets\/(styles|IntlProvider)-[^/]+\.js$/.test(e.path));
    if (!rendererEntries.length) throw new Error("Renderer style/Intl chunks not found.");

    const patched = new Map();
    let results = [];

    // host
    let h = hostText;
    // Relocation: if a bootstrap from a different folder is present (module was
    // moved or re-cloned), rewrite it to point here.
    if (h.includes("ZCODE_DISCORD_MODULE")) {
      if (!BOOT_RE.test(h)) throw new Error("Existing bootstrap found but its host anchors changed — ZCode updated in an unexpected way; re-check anchors.");
      const norm = h.replace(BOOT_RE, () => BOOT_LEFT + hostBootstrap() + BOOT_RIGHT);
      results.push(["host/index.js", "host-bootstrap-path", norm === h ? "already-current" : "relocated"]);
      h = norm;
    }
    for (const p of hostPatches()) {
      const r = applyPatch(h, p);
      results.push(["host/index.js", p.id, r.status]);
      if (r.status === "anchor-missing" || r.status === "anchor-ambiguous") throw new Error(`Anchor problem in host/index.js (${p.id}: ${r.status}). ZCode may have updated — anchors need revisiting.`);
      h = r.text;
    }
    if (h !== hostText) { syntaxCheck("host", h); patched.set("/out/host/index.js", Buffer.from(h, "utf8")); }

    // renderer
    for (const re of rendererEntries) {
      const buf = Buffer.alloc(re.node.size);
      src.readFully(buf, re.node.size, src.base + parseInt(re.node.offset, 10));
      let t = buf.toString("utf8");
      let changed = false;
      for (const p of rendererPatches().filter(p => !p.fileHint || re.path.includes(p.fileHint))) {
        const r = applyPatch(t, p);
        results.push([path.basename(re.path), p.id, r.status]);
        if (r.status === "anchor-missing" || r.status === "anchor-ambiguous") {
          if (p.optional) { results.push([path.basename(re.path), p.id + " (optional skipped)", "warn"]); continue; }
          throw new Error(`Anchor problem in ${re.path} (${p.id}: ${r.status}). ZCode may have updated — anchors need revisiting.`);
        }
        t = r.text;
        if (t !== buf.toString("utf8")) changed = true;
      }
      if (changed) { syntaxCheck(path.basename(re.path), t); patched.set(re.path, Buffer.from(t, "utf8")); }
    }

    for (const r of results) console.log(`  [${r[2].padEnd(18)}] ${r[0]} :: ${r[1]}`);
    const already = patched.size === 0;
    if (mode === "--check") {
      console.log(already ? "State: fully patched." : "State: needs patching (" + patched.size + " files).");
      return;
    }
    if (already) { console.log("Already patched — nothing to do."); return; }
    if (!process.env.ZCODE_PATCH_FORCE && zcodeRunning()) throw new Error("ZCode is running. Quit it completely (system tray too), then re-run. (or set ZCODE_PATCH_FORCE=1)");

    if (!fs.existsSync(BACKUP)) {
      console.log("Backing up original app.asar -> " + BACKUP);
      fs.copyFileSync(ASAR, BACKUP);
    }
    const tmp = path.join(RESOURCES, "app.asar.zcode-discord.tmp");
    const { newHeader, plan } = buildPlan(src, patched);
    console.log("Writing patched archive (" + (plan.reduce((a, e) => a + e.size, 0) / 1048576).toFixed(0) + " MB data)...");
    writeAsar(src, newHeader, plan, tmp);

    // verify the new archive parses and the patched files are readable
    const check = openAsar(tmp);
    try {
      for (const p of patched.keys()) {
        const e = check.entries.find(x => x.path === p);
        if (!e) throw new Error("patched entry missing in new archive: " + p);
        const b = Buffer.alloc(e.node.size);
        check.readFully(b, e.node.size, check.base + parseInt(e.node.offset, 10));
        if (!b.equals(patched.get(p))) throw new Error("round-trip mismatch for " + p);
      }
    } finally { check.close(); }

    fs.rmSync(ASAR, { force: true });
    fs.renameSync(tmp, ASAR);
    console.log("Patched " + ASAR);
    console.log("Backup kept at " + BACKUP + "  (--restore to undo)");
    console.log("Start ZCode, DM your Discord bot, then /bind <code> from ZCode > Bots.");
  } finally {
    src.close();
  }
}

try { main(); } catch (e) { console.error("patch-zcode-asar: " + e.message); process.exit(1); }
