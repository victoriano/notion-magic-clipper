import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";
import { readSchemaCache, refreshSchemaCache } from "@/lib/dbSchemaCache";

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

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = cookies().get("sb_user_id")?.value;
  if (!userId) return withCors(req, NextResponse.json({ error: "Login required" }, { status: 401 }));
  if (!supabaseAdmin)
    return withCors(req, NextResponse.json({ error: "Server misconfigured" }, { status: 500 }));

  const { searchParams } = new URL(req.url);
  const shape = (searchParams.get("shape") as "simplified" | "raw") || "simplified";
  const clientVersion = searchParams.get("version") || "";
  const dbId = params.id;

  try {
    const cached = await readSchemaCache(userId, dbId, shape);
    if (cached.version && clientVersion && clientVersion === cached.version) {
      return withCors(req, new NextResponse(null, { status: 304 }));
    }

    if (!cached.schema) {
      // Populate immediately when missing
      const refreshed = await refreshSchemaCache(userId, dbId);
      const payload = {
        db_id: dbId,
        version: refreshed.version,
        updated_at: new Date().toISOString(),
        schema: shape === "raw" ? refreshed.raw : refreshed.simplified,
      };
      return withCors(req, NextResponse.json(payload));
    }

    // Fire-and-forget refresh when stale
    if (cached.stale) {
      refreshSchemaCache(userId, dbId).catch(() => {});
    }

    return withCors(
      req,
      NextResponse.json({
        db_id: cached.db_id,
        version: cached.version,
        updated_at: cached.updated_at,
        schema: cached.schema,
        stale: cached.stale,
      }),
    );
  } catch (e: any) {
    return withCors(req, NextResponse.json({ error: String(e?.message || e) }, { status: 500 }));
  }
}


