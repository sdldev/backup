export const API_BASE_URL =
  import.meta.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000";
const SERVER_API_BASE_URL =
  import.meta.env.INTERNAL_API_BASE_URL ??
  globalThis.process?.env?.INTERNAL_API_BASE_URL ??
  API_BASE_URL;

export async function apiFetch(
  path: string,
  request: Request,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  try {
    return await fetch(`${SERVER_API_BASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    console.error(
      `[apiFetch] Failed ${path}:`,
      error instanceof Error ? error.message : error,
    );

    return new Response(
      JSON.stringify({
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "API server is unavailable",
        },
      }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  }
}
