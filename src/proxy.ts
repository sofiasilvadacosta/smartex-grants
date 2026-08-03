export { auth as proxy } from "@/lib/auth";

export const config = {
  // Run on every route except static assets, image optimization, and the
  // Auth.js API itself (must stay reachable to complete the OAuth flow).
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
