const DEFAULT_CUSTOM_API_URL = "http://localhost:11434/v1";

export function customProviderBaseUrl(
  env: Record<string, string | undefined>,
): string {
  const customUrl = env.CUSTOM_API_URL;

  if (!customUrl) {
    return DEFAULT_CUSTOM_API_URL;
  }

  return validateCustomApiUrl(customUrl, env.BAB_ALLOW_INSECURE_CUSTOM === "1");
}

export function validateCustomApiUrl(
  rawUrl: string,
  allowInsecure: boolean,
): string {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("CUSTOM_API_URL must be a valid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("CUSTOM_API_URL must use http:// or https://");
  }

  if (url.protocol === "http:" && !allowInsecure) {
    throw new Error(
      "CUSTOM_API_URL must use https:// unless BAB_ALLOW_INSECURE_CUSTOM=1",
    );
  }

  if (isBlockedHost(url.hostname)) {
    throw new Error("CUSTOM_API_URL host is not allowed");
  }

  return url.toString();
}

function isBlockedHost(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isBlockedIpv4(ipv4);
  }

  return isBlockedIpv6(normalized);
}

function parseIpv4(
  hostname: string,
): [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/u.test(part)) return undefined;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : undefined;
  });

  if (octets.some((octet) => octet === undefined)) return undefined;
  return octets as [number, number, number, number];
}

function isBlockedIpv4([a, b, c, d]: [
  number,
  number,
  number,
  number,
]): boolean {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;

  return a === 127 && !(b === 0 && c === 0 && d === 1);
}

function isBlockedIpv6(hostname: string): boolean {
  if (hostname === "::1") return false;
  return (
    hostname.startsWith("fe80:") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd")
  );
}
