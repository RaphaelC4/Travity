/**
 * Travity wallet connection.
 *
 * Uses WalletConnect (QR modal, mobile-friendly) when a Project ID is set,
 * otherwise falls back to an injected EIP-1193 provider (Rabby / MetaMask).
 * The returned provider+account are handed to genlayer-js (`createClient`) so
 * contract writes are signed by the connected wallet on Studionet.
 */

import { EthereumProvider } from "@walletconnect/ethereum-provider";

const CHAIN_ID = Number(import.meta.env.VITE_GENLAYER_CHAIN_ID || 61999);

// Mirrors genlayer-js's studionet chain (chains/index.ts) so the wallet can be
// added/switched with wallet_addEthereumChain. 61999 = 0xF22F.
const STUDIONET_CHAIN = {
  chainId: `0x${CHAIN_ID.toString(16)}`,
  chainName: "Genlayer Studio Network",
  rpcUrls: ["https://studio.genlayer.com/api"],
  nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 },
  blockExplorerUrls: ["https://genlayer-explorer.vercel.app"],
};

/** Ensure the provider is on the GenLayer Studio Network before signing. */
export async function ensureStudionetChain(provider) {
  if (!provider?.request) return;
  const current = await provider.request({ method: "eth_chainId" }).catch(() => "");
  if (String(current).toLowerCase() === STUDIONET_CHAIN.chainId.toLowerCase()) return;
  // wallet_addEthereumChain is an optimisation: wallets that already know the
  // chain (or don't support adding) reject it, and that's fine — the switch is
  // what actually matters. Never let the add step abort the connection.
  await provider
    .request({ method: "wallet_addEthereumChain", params: [STUDIONET_CHAIN] })
    .catch(() => {});
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: STUDIONET_CHAIN.chainId }],
    });
  } catch (err) {
    if (String(err?.code) === "4902") {
      // Wallet won't switch to a chain it doesn't have and the add above was
      // rejected, so give the user the exact params instead of a raw error.
      throw new Error(
        "Could not switch your wallet to the GenLayer Studio Network (chainId 61999). " +
          "Approve the network prompt in your wallet, or add the network manually " +
          "(RPC https://studio.genlayer.com/api, chainId 61999, symbol GEN) and retry."
      );
    }
    throw err;
  }
}

const WC_METHODS = [
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_requestAccounts",
  "personal_sign",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
];

const listeners = new Set();
let state = { status: "disconnected", account: null, provider: null };

function emit() {
  for (const fn of listeners) fn(state);
}

export function subscribeWallet(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getWallet() {
  return state;
}

export function shortAddress(a = "") {
  if (!a) return "";
  return a.length > 12 ? `${a.slice(0, 6)}\u2026${a.slice(-4)}` : a;
}

async function connectInjected(ethereum) {
  await ensureStudionetChain(ethereum);
  const accounts = await ethereum.request({ method: "eth_requestAccounts" });
  return { provider: ethereum, account: accounts[0] };
}

async function connectWalletConnect() {
  const provider = await EthereumProvider.init({
    projectId: import.meta.env.VITE_WC_PROJECT_ID,
    chains: [CHAIN_ID],
    optionalChains: [CHAIN_ID],
    methods: WC_METHODS,
    showQrModal: true,
  });
  await provider.connect(); // opens the WalletConnect QR modal
  await ensureStudionetChain(provider);
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  return { provider, account: accounts[0] };
}

export async function connectWallet() {
  const projectId = import.meta.env.VITE_WC_PROJECT_ID;
  let connected;
  if (projectId) {
    connected = await connectWalletConnect();
  } else if (window.ethereum) {
    connected = await connectInjected(window.ethereum);
  } else {
    throw new Error(
      "No wallet found. Install a GEN-capable wallet extension (Rabby or MetaMask) " +
        "or set VITE_WC_PROJECT_ID in frontend/.env for WalletConnect."
    );
  }
  state = { status: "connected", ...connected };
  emit();
  return state;
}

export function disconnectWallet() {
  try {
    state.provider?.disconnect?.();
  } catch {
    /* wallet already gone */
  }
  state = { status: "disconnected", account: null, provider: null };
  emit();
}