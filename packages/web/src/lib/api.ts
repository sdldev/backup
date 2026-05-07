export const API_BASE_URL =
  import.meta.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000";
const SERVER_API_BASE_URL =
  import.meta.env.INTERNAL_API_BASE_URL ?? API_BASE_URL;

export async function apiFetch(
  path: string,
  request: Request,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  return fetch(`${SERVER_API_BASE_URL}${path}`, {
    ...init,
    headers,
  });
}
