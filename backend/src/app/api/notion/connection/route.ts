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
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspace_id");
  if (!workspaceId)
    return withCors(req, NextResponse.json({ error: "Missing workspace_id" }, { status: 400 }));
  const userId = cookies().get("sb_user_id")?.value;
  if (!userId)
    return withCors(req, NextResponse.json({ error: "Login required" }, { status: 401 }));
  if (!supabaseAdmin)
    return withCors(req, NextResponse.json({ error: "Server misconfigured" }, { status: 500 }));
  const { error } = await supabaseAdmin
    .from("notion_connections")
    .delete()
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId);
  if (error) return withCors(req, NextResponse.json({ error: error.message }, { status: 500 }));
  return withCors(req, NextResponse.json({ ok: true }));
}
