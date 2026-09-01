import type { CookieOptions, Request } from "express";

export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  void req;
  // The app is always reached by the user's browser over HTTPS (preview
  // gateway iframe, Railway, or localhost which Chromium treats as a secure
  // context). Internal proxy hops are plain HTTP, so relying on
  // X-Forwarded-Proto to decide `secure` produced `SameSite=Lax; Secure=false`
  // cookies that browsers reject inside the cross-site preview iframe,
  // causing an endless login loop. Always emit `SameSite=None; Secure=true`:
  // it is the only combination accepted in third-party iframe contexts and
  // remains valid for top-level HTTPS navigation.
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: true,
  };
}
