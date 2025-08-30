import env from "@/lib/env";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = cookies().get("notion_oauth_state")?.value;
  const userId = cookies().get("sb_user_id")?.value;

  if (!code || !state || !storedState || state !== storedState) {
    return NextResponse.json({ error: "Invalid OAuth state or missing code" }, { status: 400 });
  }
  if (!userId) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  try {
    const tokenRes = await fetch(NOTION_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: env.NOTION_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return NextResponse.json({ error: "Failed to exchange token", detail: err }, { status: 500 });
    }

    const tokenJson = await tokenRes.json();
    // tokenJson contains access_token, workspace_id, workspace_name, bot_id, duplicated fields

    if (!supabaseAdmin) throw new Error("Server not configured with service role key");
    const upsertRes = await supabaseAdmin
      .from("notion_connections")
      .upsert(
        {
          user_id: userId,
          workspace_id: tokenJson.workspace_id,
          workspace_name: tokenJson.workspace_name,
          access_token: tokenJson.access_token,
          bot_id: tokenJson.bot_id ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,workspace_id" },
      )
      .select()
      .single();

    if (upsertRes.error) {
      return NextResponse.json(
        { error: "Failed to store token", detail: upsertRes.error.message },
        { status: 500 },
      );
    }

    cookies().delete("notion_oauth_state");

    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_BASE_URL}/connected?workspace_id=${encodeURIComponent(tokenJson.workspace_id)}`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
