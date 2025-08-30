import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";

function withCors(req: NextRequest, res: NextResponse) {
  const origin = req.headers.get("origin") || "*";
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Access-Control-Allow-Credentials", "true");
  return res;
}

export async function OPTIONS(req: NextRequest) {
  return withCors(req, new NextResponse(null, { status: 204 }));
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = cookies().get("sb_user_id")?.value;
  if (!userId) return withCors(req, NextResponse.json({ error: "Login required" }, { status: 401 }));
  if (!supabaseAdmin)
    return withCors(req, NextResponse.json({ error: "Server misconfigured" }, { status: 500 }));
  const dbId = params.id;
  try {
    const { data, error } = await supabaseAdmin
      .from("db_settings")
      .select("prompt, save_article, customize_content, content_prompt, updated_at")
      .eq("user_id", userId)
      .eq("db_id", dbId)
      .maybeSingle();
    if (error) throw error;
    const defaults = {
      prompt: "",
      save_article: true,
      customize_content: false,
      content_prompt: "",
    };
    const row = data || defaults;
    return withCors(req, NextResponse.json({ settings: row }));
  } catch (e: any) {
    return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
  }
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = cookies().get("sb_user_id")?.value;
  if (!userId) return withCors(req, NextResponse.json({ error: "Login required" }, { status: 401 }));
  if (!supabaseAdmin)
    return withCors(req, NextResponse.json({ error: "Server misconfigured" }, { status: 500 }));
  const dbId = params.id;
  try {
    const body = await req.json();
    const prompt = typeof body?.prompt === "string" ? body.prompt : undefined;
    const save_article =
      typeof body?.save_article === "boolean" ? body.save_article : undefined;
    const customize_content =
      typeof body?.customize_content === "boolean" ? body.customize_content : undefined;
    const content_prompt =
      typeof body?.content_prompt === "string" ? body.content_prompt : undefined;

    const update: any = { updated_at: new Date().toISOString() };
    if (prompt !== undefined) update.prompt = prompt;
    if (save_article !== undefined) update.save_article = save_article;
    if (customize_content !== undefined) update.customize_content = customize_content;
    if (content_prompt !== undefined) update.content_prompt = content_prompt;

    const { data, error } = await supabaseAdmin
      .from("db_settings")
      .upsert(
        { user_id: userId, db_id: dbId, ...update },
        { onConflict: "user_id,db_id" },
      )
      .select("prompt, save_article, customize_content, content_prompt, updated_at")
      .maybeSingle();
    if (error) throw error;
    return withCors(req, NextResponse.json({ settings: data }));
  } catch (e: any) {
    return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
  }
}


