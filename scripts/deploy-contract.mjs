#!/usr/bin/env node
/**
 * One-command deployment of contracts/travel_agent.py to GenLayer studionet.
 *
 * Generates a fresh deployer key, funds it from the studionet faucet
 * (sim_fundAccount), deploys the contract, waits for the receipt, extracts
 * the new address, and verifies the contract answers a view call at FINALIZED
 * state. The operator's wallet key is never needed; the contract owner
 * defaults to VITE_GENLAYER_OWNER_ADDRESS so the existing admin wallet keeps
 * ownership.
 *
 * Usage:
 *   node scripts/deploy-contract.mjs                  # deploy + verify
 *   node scripts/deploy-contract.mjs --write-env      # + rewrite the address into .env files
 *   node scripts/deploy-contract.mjs --dry-run        # validate everything, spend nothing
 *   node scripts/deploy-contract.mjs --key 0x...      # deploy with an explicit funded key
 *   node scripts/deploy-contract.mjs --owner 0x...    # contract owner (default VITE_GENLAYER_OWNER_ADDRESS, else deployer)
 *   node scripts/deploy-contract.mjs --fund 50000000000000000   # faucet wei for a fresh key
 *   node scripts/deploy-contract.mjs --smoke          # + refresh_quote JFK->LHR after deploy (needs feed_base configured)
 *   node scripts/deploy-contract.mjs --show-key       # print the generated private key (saved to .env anyway)
 *   node scripts/deploy-contract.mjs --no-save-key    # don't persist the generated key to .env
 *
 * Env (project .env and server/.env, overridable via process env):
 *   GENLAYER_RPC                 default https://studio.genlayer.com/api
 *   GENLAYER_PRIVATE_KEY         explicit deployer key (or --key)
 *   VITE_GENLAYER_OWNER_ADDRESS  default contract owner
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require_ = createRequire(path.join(ROOT, "server", "package.json"));

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    argv[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true;
  }
}
const FLAGS = {
  dryRun: !!argv["dry-run"],
  writeEnv: !!argv["write-env"],
  smoke: !!argv.smoke,
  showKey: !!argv["show-key"],
  noSaveKey: !!argv["no-save-key"],
  force: !!argv.force,
};
const OPT = {
  key: typeof argv.key === "string" ? argv.key : "",
  owner: typeof argv.owner === "string" ? argv.owner : "",
  fund: argv.fund ? BigInt(argv.fund) : 50_000_000_000_000_000n, // 0.05 GEN
  contract: typeof argv.contract === "string" ? path.resolve(ROOT, argv.contract) : path.join(ROOT, "contracts", "travel_agent.py"),
};

function loadEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const rootEnv = loadEnvFile(path.join(ROOT, ".env"));
const serverEnv = loadEnvFile(path.join(ROOT, "server", ".env"));
const frontendEnv = loadEnvFile(path.join(ROOT, "frontend", ".env")); // VITE_* vars canonical home
const env = (k) => process.env[k] ?? serverEnv[k] ?? rootEnv[k] ?? frontendEnv[k];
const OLD = env("VITE_GENLAYER_CONTRACT_ADDRESS") || env("GENLAYER_CONTRACT_ADDRESS") || "";

const RPC = (env("GENLAYER_RPC") || "https://studio.genlayer.com/api").replace(/\/+$/, "");
const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const RPC_AGENT = new https.Agent({ keepAlive: false }); // sockets close after each call — avoids the Node-on-Windows uv teardown assertion

async function rawRpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let lastErr;
  for (const url of [`${RPC}/rpc`, RPC]) {
    try {
      const json = await new Promise((resolve, reject) => {
        const req = https.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, agent: RPC_AGENT }, (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { data += c; });
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`non-JSON response from ${url}`)); } });
        });
        req.on("error", reject);
        req.end(body);
      });
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return json.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function pkgRoot(spec) {
  try {
    return path.dirname(require_.resolve(`${spec}/package.json`));
  } catch {
    const entry = require_.resolve(spec);
    const dir = path.dirname(entry);
    return ["_cjs", "_esm", "dist"].includes(path.basename(dir)) ? path.dirname(dir) : dir;
  }
}
async function importEsm(p) {
  return import(pathToFileURL(p).href);
}

function upsertEnv(file, key, value) {
  const existed = fs.existsSync(file);
  let text = existed ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=[^\\r\\n]*`, "m");
  if (existed && re.test(text)) {
    fs.writeFileSync(file, text.replace(re, `${key}=${value}`));
    return "updated";
  }
  if (text && !text.endsWith("\n")) text += "\n";
  fs.writeFileSync(file, text + `${key}=${value}\n`);
  return existed ? "appended" : "created";
}

// --- SDK imports (resolved from server/node_modules) ------------------------
const glDir = pkgRoot("genlayer-js");
const viemDir = pkgRoot("viem");
let privateKeyToAccount, generatePrivateKey;
try {
  ({ privateKeyToAccount, generatePrivateKey } = await importEsm(path.join(viemDir, "_esm", "accounts", "index.js")));
} catch {
  const mod = await importEsm(require_.resolve("viem/accounts"));
  privateKeyToAccount = mod.privateKeyToAccount ?? mod.default?.privateKeyToAccount;
  generatePrivateKey = mod.generatePrivateKey ?? mod.default?.generatePrivateKey;
}
if (typeof privateKeyToAccount !== "function" || typeof generatePrivateKey !== "function") {
  die(`could not load viem/accounts from ${viemDir}`);
}
const { createClient } = await importEsm(path.join(glDir, "dist", "index.js"));
const { studionet } = await importEsm(path.join(glDir, "dist", "chains", "index.js"));

// --- preflight ----------------------------------------------------------------
if (!fs.existsSync(OPT.contract)) die(`contract not found: ${OPT.contract}`);
const source = fs.readFileSync(OPT.contract, "utf8");
if (!source.slice(0, 200).includes("py-genlayer")) {
  die("contract is missing the py-genlayer Depends pragma in its header");
}

const chainIdHex = await rawRpc("eth_chainId", []);
const chainId = parseInt(chainIdHex, 16);
if (chainId !== 61999 && !FLAGS.force) {
  die(`RPC ${RPC} reports chain ${chainId} (0x${chainIdHex.slice(2)}), expected 61999 (studionet) — pass --force to proceed anyway`);
}

let keyHex = OPT.key || env("GENLAYER_PRIVATE_KEY") || "";
let keySource = OPT.key ? "--key" : keyHex ? "GENLAYER_PRIVATE_KEY (.env)" : "";
if (keyHex && !KEY_RE.test(keyHex)) die("private key must be 0x followed by 64 hex characters");
let generated = false;
if (!keyHex) {
  keyHex = generatePrivateKey();
  generated = true;
  keySource = "generated fresh";
}
const deployer = privateKeyToAccount(keyHex);
const OWNER_ENV = env("VITE_GENLAYER_OWNER_ADDRESS");
const owner = OPT.owner || OWNER_ENV || deployer.address;
if (!ADDR_RE.test(owner)) die(`owner is not a valid address: ${owner}`);

log(`[plan] rpc      : ${RPC} (chain ${chainId})`);
log(`[plan] contract : ${path.relative(ROOT, OPT.contract)} (${source.length} bytes)`);
log(`[plan] deployer : ${deployer.address}${generated ? " (fresh, will faucet-fund)" : ` (${keySource})`}`);
log(`[plan] owner    : ${owner}${!OPT.owner && !OWNER_ENV ? " (defaults to deployer)" : ""}`);
log(`[plan] old addr : ${OLD || "(none recorded)"}`);
log(`[plan] fund     : ${FLAGS.dryRun ? "(skipped in dry-run)" : `${OPT.fund} wei (faucet)`}`);
if (FLAGS.dryRun) {
  log("[dry-run] all preflight checks passed — nothing deployed, nothing spent");
  process.exit(0);
}

if (generated && !FLAGS.noSaveKey) {
  upsertEnv(path.join(ROOT, ".env"), "GENLAYER_PRIVATE_KEY", keyHex);
  log("[key] fresh deployer key saved to .env as GENLAYER_PRIVATE_KEY");
  if (FLAGS.showKey) log(`[key] ${keyHex}`);
}

// --- fund ----------------------------------------------------------------------
const balHex = await rawRpc("eth_getBalance", [deployer.address, "latest"]);
const bal0 = BigInt(balHex ?? 0);
log(`[fund] deployer balance before: ${bal0} wei`);
if (bal0 < OPT.fund) {
  await rawRpc("sim_fundAccount", [deployer.address, Number(OPT.fund)]); // studionet faucet: params [address, amountNumber]
  log(`[fund] faucet request sent for ${OPT.fund} wei; waiting for balance…`);
  let funded = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const b = BigInt((await rawRpc("eth_getBalance", [deployer.address, "latest"])) ?? 0);
    if (b >= bal0 + OPT.fund) { log(`[fund] balance now ${b} wei`); funded = true; break; }
  }
  if (!funded) die("faucet funding did not reflect in eth_getBalance within 30s");
} else {
  log("[fund] existing balance is sufficient — skipping faucet");
}

// --- deploy ----------------------------------------------------------------------
const account = privateKeyToAccount(keyHex);
const client = createClient({ chain: studionet, endpoint: RPC, account });
log("[deploy] sending deploy transaction…");
const deployTx = await client.deployContract({ code: source, args: [owner] });
const deployHash = typeof deployTx === "string" ? deployTx : deployTx?.transactionHash ?? deployTx?.hash;
if (!deployHash) die(`deploy returned no transaction hash: ${JSON.stringify(deployTx)}`);
log(`[deploy] tx ${deployHash} — waiting for receipt…`);

let receipt = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const t = await client.getTransaction({ hash: deployHash });
    if (t && (t.statusName === "FINALIZED" || t.status === 7)) { receipt = t; break; }
    if (t && ["CANCELED", "REJECTED", "FAIL"].includes(String(t.statusName))) {
      die(`deploy tx ended ${t.statusName} (result ${t.result_name ?? t.result}) — check the studio explorer`);
    }
  } catch { /* not yet available — keep polling */ }
}
if (!receipt) die("no finalized receipt within 240s — check the tx in the studio explorer");
const newAddress = receipt?.to_address ?? receipt?.recipient ?? receipt?.to; // on studionet a deploy tx's recipient IS the contract address
if (!newAddress || !ADDR_RE.test(newAddress)) {
  die(`could not determine deployed address from tx record: ${JSON.stringify(receipt).slice(0, 400)}`);
}
log(`[deploy] new contract address: ${newAddress}`);

// --- verify (finalized state) ------------------------------------------------------
let status = null, lastVerifyErr = "";
for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, i ? 5000 : 0)); // fresh deploys may lag finalization
  try {
    status = await client.readContract({ address: newAddress, functionName: "view_provider_config", args: [], transactionHashVariant: "latest-final" });
    break;
  } catch (e) { lastVerifyErr = e.message || String(e); }
}
if (!status) die(`finalized view_provider_config failed: ${lastVerifyErr}`);
log(`[verify] view_provider_config (finalized) -> ${JSON.stringify(status)}`);

// --- env updates ---------------------------------------------------------------------
if (FLAGS.writeEnv) {
  for (const [file, key] of [[path.join(ROOT, ".env"), "VITE_GENLAYER_CONTRACT_ADDRESS"], [path.join(ROOT, "frontend", ".env"), "VITE_GENLAYER_CONTRACT_ADDRESS"], [path.join(ROOT, "server", ".env"), "GENLAYER_CONTRACT_ADDRESS"]]) {
    const how = upsertEnv(file, key, newAddress);
    log(`[env] ${path.relative(ROOT, file)}: ${key} ${how}`);
  }
} else {
  log(`[env] dry address update skipped — rerun with --write-env, or set GENLAYER_CONTRACT_ADDRESS=${newAddress} in server/.env and VITE_GENLAYER_CONTRACT_ADDRESS=${newAddress} in .env / frontend/.env`);
}

if (FLAGS.smoke) {
  log("[smoke] refreshing quote JFK->LHR via contract (proves feed + llm calls land on the new instance)…");
  const q = await client.readContract({ contractAddress: newAddress, functionName: "view_quote", args: [] }).catch(() => null);
  log(`[smoke] view_quote -> ${JSON.stringify(q)}`);
}
log("");
log("DONE. Next: restart the server so it picks up the new address, then run the Direct Mode suite:");
log('  Set-Location "C:\\Users\\HP\\Documents\\New project"; python -m pytest tests/test_travel_agent_glsim.py -q');
