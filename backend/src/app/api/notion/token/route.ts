import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { cookies } from "next/headers";

function withCors(req: NextRequest, res: NextResponse) {
  const origin = req.headers.get("origin") || "*";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Access-Control-Allow-Credentials", "true");
  return res;
}

export async function OPTIONS(req: NextRequest) {
  return withCors(req, new NextResponse(null, { status: 204 }));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get("workspace_id");
  if (!workspaceId) {
    return withCors(req, NextResponse.json({ error: "Missing workspace_id" }, { status: 400 }));
  }
  const userId = cookies().get("sb_user_id")?.value;
  if (!userId) {
    return withCors(req, NextResponse.json({ error: "Login required" }, { status: 401 }));
  }
  if (!supabaseAdmin) {
    return withCors(req, NextResponse.json({ error: "Server misconfigured" }, { status: 500 }));
  }

  const { data, error } = await supabaseAdmin
    .from("notion_connections")
    .select("workspace_id, workspace_name, access_token, bot_id, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return withCors(req, NextResponse.json({ error: "Not found" }, { status: 404 }));
  }

  return withCors(
    req,
    NextResponse.json({
      workspace_id: data.workspace_id,
      workspace_name: data.workspace_name,
      access_token: data.access_token,
      bot_id: data.bot_id,
      updated_at: data.updated_at,
    }),
  );
}
