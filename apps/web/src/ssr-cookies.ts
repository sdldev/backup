export function forwardCookieHeader(request: Request): Record<string, string> {
  const cookie = request.headers.get("cookie");

  if (!cookie) {
    return {};
  }

  return { cookie };
}
