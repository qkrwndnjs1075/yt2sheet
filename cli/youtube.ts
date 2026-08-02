export function parseYouTubeVideoId(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "youtu.be") {
    return cleanVideoId(parsed.pathname.slice(1));
  }

  if (!isYouTubeHost(host)) {
    return null;
  }

  if (parsed.pathname === "/watch") {
    return cleanVideoId(parsed.searchParams.get("v"));
  }

  if (parsed.pathname.startsWith("/shorts/")
    || parsed.pathname.startsWith("/embed/")
    || parsed.pathname.startsWith("/live/")) {
    return cleanVideoId(parsed.pathname.split("/")[2]);
  }

  return null;
}

export function isYouTubeWatchUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return isYouTubeHost(parsed.hostname.toLowerCase()) && parsed.pathname === "/watch" && Boolean(parseYouTubeVideoId(url));
}

function isYouTubeHost(host: string): boolean {
  return host === "youtube.com" || host.endsWith(".youtube.com");
}

function cleanVideoId(value: string | null): string | null {
  if (!value || !/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return null;
  }

  return value;
}
