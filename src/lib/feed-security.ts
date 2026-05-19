import dns from "node:dns/promises";
import net from "node:net";

export type FeedUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; status: number; error: string };

const MAX_URL_LENGTH = 2048;

export function parseFeedUrl(rawUrl: string | null): FeedUrlValidation {
  if (!rawUrl?.trim()) {
    return { ok: false, status: 400, error: "Missing RSS feed URL." };
  }

  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, status: 400, error: "Feed URL is too long." };
  }

  let url: URL;

  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, status: 400, error: "Invalid RSS feed URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      status: 400,
      error: "Only http:// and https:// feed URLs are allowed.",
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      status: 400,
      error: "Feed URLs with embedded credentials are not allowed.",
    };
  }

  return { ok: true, url };
}

export async function ensurePublicFeedUrl(url: URL): Promise<FeedUrlValidation> {
  const parsed = parseFeedUrl(url.toString());

  if (!parsed.ok) {
    return parsed;
  }

  const hostname = parsed.url.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return {
      ok: false,
      status: 400,
      error: "Local or private network feed URLs are not allowed.",
    };
  }

  if (isPrivateOrLocalAddress(hostname)) {
    return {
      ok: false,
      status: 400,
      error: "Local or private network feed URLs are not allowed.",
    };
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true });

    if (addresses.some(({ address }) => isPrivateOrLocalAddress(address))) {
      return {
        ok: false,
        status: 400,
        error: "Local or private network feed URLs are not allowed.",
      };
    }
  } catch {
    return {
      ok: false,
      status: 502,
      error: "Could not resolve the feed host.",
    };
  }

  return parsed;
}

function isPrivateOrLocalAddress(address: string) {
  const ipVersion = net.isIP(address);

  if (ipVersion === 4) {
    return isPrivateOrLocalIpv4(address);
  }

  if (ipVersion === 6) {
    return isPrivateOrLocalIpv6(address);
  }

  return false;
}

function isPrivateOrLocalIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [first, second] = parts;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateOrLocalIpv6(address: string) {
  const normalized = address.toLowerCase();

  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}
