import { useCallback, useEffect, useState } from "react";
import {
  connectWallet,
  disconnectWallet,
  getWallet,
  subscribeWallet,
} from "../lib/wallet";

export function useWallet() {
  const [w, setW] = useState(getWallet());

  useEffect(() => subscribeWallet(setW), []);

  const connect = useCallback(async () => connectWallet(), []);
  const disconnect = useCallback(() => disconnectWallet(), []);

  return { status: w.status, account: w.account, provider: w.provider, connect, disconnect };
}