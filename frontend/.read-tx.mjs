import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const TX_HASH = process.argv[2];
const client = createClient({ chain: studionet, endpoint: "https://studio.genlayer.com/api" });

const consensus = client.chain.consensusMainContract;
console.error("consensus:", consensus.address);

const data = await client.readContract({
  address: consensus.address,
  functionName: "getTransactionAllData",
  args: [TX_HASH],
});

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

const s = JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
// Print everything but trim huge blobs
const trimmed = s.length > 14000 ? s.slice(0, 6000) + "\n...\n" + s.slice(-6000) : s;
console.log(trimmed);
