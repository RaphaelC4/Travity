import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0xC3A744CAe8F4A625b6026D8d70F18a095e683f2e";
const BOOKING_ID = process.argv[2];

const client = createClient({ chain: studionet, endpoint: "https://studio.genlayer.com/api" });
const raw = await client.readContract({
  address: CONTRACT,
  functionName: "view_booking",
  args: [BOOKING_ID],
});
console.log(JSON.stringify(raw, null, 2));
