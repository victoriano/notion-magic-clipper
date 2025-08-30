import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  try {
    const url = "https://models.dev/api.json";
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok)
      return NextResponse.json({ error: `Fetch failed: ${resp.status}` }, { status: 502 });
    const data = await resp.json();
    const rows: any[] = [];
    const now = new Date();
    for (const [providerKey, providerVal] of Object.entries<any>(data)) {
      const provider = providerVal?.name?.toLowerCase?.() || providerKey;
      const models = providerVal?.models || {};
      for (const [modelKey, modelVal] of Object.entries<any>(models)) {
        const cost = modelVal?.cost || {};
        if (typeof cost?.input !== "number" || typeof cost?.output !== "number") continue;
        // Costs are USD per 1M tokens or 1K? The API lists per 1K USD typically
        // models.dev reports costs per 1M tokens; normalize to per 1K for storage
        const per1kIn = Number(cost.input) / 1000;
        const per1kOut = Number(cost.output) / 1000;
        const per1kCacheRead = cost.cache_read != null ? Number(cost.cache_read) / 1000 : null;
        const per1kCacheWrite = cost.cache_write != null ? Number(cost.cache_write) / 1000 : null;
        rows.push({
          provider,
          model: modelKey,
          input_usd_per_1k: per1kIn,
          output_usd_per_1k: per1kOut,
          cache_read_usd_per_1k: per1kCacheRead,
          cache_write_usd_per_1k: per1kCacheWrite,
          effective_from: now.toISOString(),
          source_url: url,
        });
      }
    }
    if (rows.length === 0) return NextResponse.json({ inserted: 0 });
    const { error } = await supabaseAdmin.from("llm_pricing").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ inserted: rows.length });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
