import { escapeHtml } from "./util";

/** Plain white page used by every iframe / link extension. */
export function helloPage(message = "Hello DIDAR!"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hello Didar</title>
<style>
  html, body { margin: 0; height: 100%; background: #ffffff; color: #111111; color-scheme: light; }
  body { display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; }
  h1 { font-size: 28px; font-weight: 600; margin: 0; padding: 16px; text-align: center; }
</style>
</head>
<body><h1 dir="auto">${escapeHtml(message)}</h1></body>
</html>`;
}

const FRAME_HEADERS = (didarOrigin: string) => ({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${didarOrigin}`,
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
});

export function framePage(didarOrigin: string, message: string, status = 200, extra: HeadersInit = {}): Response {
  return new Response(helloPage(message), { status, headers: { ...FRAME_HEADERS(didarOrigin), ...extra } });
}

/** Link extension opens in a normal tab, so it must not be framed. */
export function linkPage(message: string, status = 200): Response {
  return new Response(helloPage(message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}
