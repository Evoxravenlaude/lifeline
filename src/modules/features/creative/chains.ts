/** The chains and tokens NFT people talk about, and how a collection name becomes a key. No rules here. */
import { cap } from "./shared.js";

interface NftChain { name: string; native: string; os?: string; me?: boolean }
export const NFT_CHAINS: Record<string, NftChain> = {
  ethereum: { name: "Ethereum", native: "ETH", os: "ethereum" },
  base: { name: "Base", native: "ETH", os: "base" },
  arbitrum: { name: "Arbitrum", native: "ETH", os: "arbitrum" },
  optimism: { name: "Optimism", native: "ETH", os: "optimism" },
  polygon: { name: "Polygon", native: "POL", os: "matic" },
  zora: { name: "Zora", native: "ETH", os: "zora" },
  blast: { name: "Blast", native: "ETH", os: "blast" },
  apechain: { name: "ApeChain", native: "APE", os: "ape_chain" },
  abstract: { name: "Abstract", native: "ETH", os: "abstract" },
  avalanche: { name: "Avalanche", native: "AVAX", os: "avalanche" },
  bsc: { name: "BNB Chain", native: "BNB", os: "bsc" },
  ronin: { name: "Ronin", native: "RON", os: "ronin" },
  solana: { name: "Solana", native: "SOL", me: true },
  tezos: { name: "Tezos", native: "XTZ" },
  bitcoin: { name: "Bitcoin", native: "BTC" },
};
export const NFT_CHAIN_WORDS = "eth|ethereum|mainnet|base|arb|arbitrum|op|optimism|polygon|matic|zora|blast|apechain|ape chain|abstract|avalanche|avax|bsc|bnb chain|bnb|sol|solana|tezos|tez|bitcoin|btc|ordinals|ronin";
export const TOKEN_WORDS = "eth|weth|sol|pol|matic|ape|avax|bnb|xtz|tez|btc|ron|usdc|usdt|degen";

export function nftChain(word?: string | null): string | null {
  const w = (word ?? "").toLowerCase().trim().replace(/\s+(?:chain|network|mainnet)$/, "");
  if (!w) return null;
  if (/^(?:eth|ethereum|mainnet|l1)$/.test(w)) return "ethereum";
  if (/^(?:arb|arbitrum)$/.test(w)) return "arbitrum";
  if (/^(?:op|optimism)$/.test(w)) return "optimism";
  if (/^(?:polygon|matic)$/.test(w)) return "polygon";
  if (/^ape ?chain$/.test(w)) return "apechain";
  if (/^(?:avalanche|avax)$/.test(w)) return "avalanche";
  if (/^(?:bsc|bnb|bnb chain)$/.test(w)) return "bsc";
  if (/^(?:sol|solana)$/.test(w)) return "solana";
  if (/^(?:tezos|tez)$/.test(w)) return "tezos";
  if (/^(?:bitcoin|btc|ordinals)$/.test(w)) return "bitcoin";
  return NFT_CHAINS[w] ? w : null;
}
export function tokenOf(word?: string | null): string | null {
  const w = (word ?? "").toUpperCase().trim();
  if (!w) return null;
  if (w === "WETH") return "ETH";
  if (w === "MATIC") return "POL";
  if (w === "TEZ") return "XTZ";
  return w;
}
export const CHAIN_FOR_TOKEN: Record<string, string> = { SOL: "solana", POL: "polygon", APE: "apechain", AVAX: "avalanche", BNB: "bsc", XTZ: "tezos", BTC: "bitcoin", RON: "ronin" };
export const chainLabel = (c: string) => NFT_CHAINS[c]?.name ?? cap(c);

/** "Pudgy Penguins" and "pudgy penguin" are the same collection. */
export function ckeyOf(name: string): string {
  const words = name.toLowerCase().replace(/#\s?\d+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length && words[words.length - 1].length > 3) words[words.length - 1] = words[words.length - 1].replace(/(?<!s)s$/, "");
  return words.join(" ");
}

