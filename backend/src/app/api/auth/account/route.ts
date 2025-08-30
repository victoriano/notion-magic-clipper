import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";

function withCors(req: NextRequest, res: NextResponse) {
  const origin = req.headers.get("origin") || "*";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Access-Control-Allow-Credentials", "true");
  return res;
}

export async function OPTIONS(req: NextRequest) {
  return withCors(req, new NextResponse(null, { status: 204 }));
}

export async function DELETE(req: NextRequest) {
  const userId = cookies().get("sb_user_id")?.value;
  if (!userId)
    return withCors(req, NextResponse.json({ error: "Not logged in" }, { status: 401 }));
  if (!supabaseAdmin)
    return withCors(req, NextResponse.json({ error: "Server misconfigured" }, { status: 500 }));
  try {
    const { reason } = (await req.json().catch(() => ({}))) as { reason?: string };
    // Start deletions in a best-effort sequence. Avoid cascading surprises; every table has RLS.
    const nowIso = new Date().toISOString();

    // Log deletion first
    try {
      await supabaseAdmin.from("account_deletions").insert({ user_id: userId, reason, deleted_at: nowIso });
    } catch {}

    // Delete user-owned rows in known tables
    const tables = [
      "notion_connections",
      "notion_db_index",
      "notion_db_schema",
      "db_settings",
      "notion_saves",
    ];
    for (const t of tables) {
      try {
        await supabaseAdmin.from(t).delete().eq("user_id", userId);
      } catch {}
    }

    // Finally, delete auth user
    try {
      await supabaseAdmin.auth.admin.deleteUser(userId);
    } catch {}

    // Clear cookie
    const res = withCors(req, NextResponse.json({ ok: true }));
    try {
      res.cookies.set("sb_user_id", "", { path: "/", maxAge: 0, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
    } catch {}
    return res;
  } catch (e: any) {
    return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
  }
}


