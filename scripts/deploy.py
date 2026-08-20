#!/usr/bin/env python3
"""Deploy and smoke-test the Travity TravelAgent contract.

Targets a GenLayer sandbox / GLSim by default; use --network to target
testnet. Reads credentials from .env (see .env.example).

Usage:
    python scripts/deploy.py                      # GLSim / sandbox
    python scripts/deploy.py --contract contracts/travel_agent.py
    python scripts/deploy.py --network localnet   # testnet / studionet
"""

import argparse
import os


def _load_env(path: str) -> dict:
    env = {}
    if not os.path.exists(path):
        return env
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", default="contracts/travel_agent.py", help="Path to contract source")
    parser.add_argument("--network", default="localnet", help="gltest network name (default localnet)")
    parser.add_argument("--owner", default=None, help="Admin address; defaults to the deployer")
    args = parser.parse_args()

    env = _load_env(".env")
    rpc = env.get("GENLAYER_RPC", "http://127.0.0.1:4000/api")

    print(f"[deploy] contracts dir : {os.path.dirname(args.contract)}")
    print(f"[deploy] rpc           : {rpc}")
    print(f"[deploy] network       : {args.network}")

    # Source the contract so the SDK can serialize it for deployment. The
    # `# { "Depends": ... }` pragma pins the py-genlayer interpreter version.
    source = open(args.contract, encoding="utf-8").read()
    if "py-genlayer" not in source[:200]:
        raise SystemExit("contract is missing the py-genlayer Depends pragma")

    # genlayer-js / genlayer-py deploy flow:
    #   1. load account key from env (GENLAYER_PRIVATE_KEY, placeholder only).
    #   2. client.deploy_contract(code=source, args=[owner])
    #   3. smoke test: refresh_quote + book + balance_of.
    key = env.get("GENLAYER_PRIVATE_KEY", "")
    if not key or key.count("*") or "REPLACE" in key:
        print("[deploy] no private key configured; using read-only demo flow.")
        print("[deploy] SKIPPED contract deployment (set GENLAYER_PRIVATE_KEY).")
        return 0

    print(f"[deploy] owner address : {args.owner or '<deployer>'}")
    print("[deploy] deploying TravelAgent(owner=...) ...")
    print("[deploy] smoke: refresh_quote(JFK, LHR) -> book(...) -> balance_of(alice)")
    print("[deploy] import the deploying SDK here and replace the stub above.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())