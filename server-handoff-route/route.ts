// GET /desktop/handoff — server side of the desktop app's system-browser
// sign-in fallback. PREPARED, NOT DEPLOYED. Do not copy this into the web
// repo until the desktop app's in-window Google sign-in is actually
// blocked (today it is not the problem — see README "Google sign-in").
//
// Flow:
//   1. User is in the desktop app; Google refuses the in-window flow.
//   2. App offers "Open sign-in in browser" -> user signs in on the web.
//   3. The web app's sign-in success page links to /desktop/handoff.
//   4. This route reads the user's better-auth session cookie and
//      redirects to `pinterest365://auth?token=<session token>`.
//   5. The desktop app's deep-link handler plants that token as the
//      `better-auth.session_token` cookie in its own session partition
//      and loads /app — the user is now signed in inside the app.
//
// Security notes:
//   - The token IS a bearer credential (same value as the session cookie).
//     It only ever travels in a redirect to a custom scheme the OS routes
//     to our registered app; it is never logged, never put in page HTML,
//     and the route only runs over HTTPS.
//   - The route requires a live server session (no session -> /sign-in).
//   - The desktop app validates the token (length, characters) before
//     planting it, and the token expires with the server session (7 days).
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export async function GET(req: NextRequest) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
        return NextResponse.redirect(new URL("/sign-in?next=/desktop/handoff", req.url));
    }
    const token = req.cookies.get("better-auth.session_token")?.value;
    if (!token) {
        return NextResponse.redirect(new URL("/app", req.url));
    }
    const url = new URL("pinterest365://auth");
    url.searchParams.set("token", token);
    return NextResponse.redirect(url.toString());
}
