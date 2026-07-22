export function proxyOriginPermissionPattern(proxyUrl: string): string | null {
  try {
    const url = new URL(proxyUrl);
    if (url.protocol === "https:") {
      return `https://${url.hostname}/*`;
    }

    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return `http://${url.hostname}/*`;
    }
  } catch {
    return null;
  }

  return null;
}

