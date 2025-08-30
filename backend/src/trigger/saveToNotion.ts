// Trigger.dev task definition (named export required by the CLI)
import { task } from "@trigger.dev/sdk";
import { runSaveToNotion, type NotionSavePayload } from "@/lib/notionSaveWorker";
import { supabaseAdmin } from "@/lib/supabase";

export const saveToNotion = task({
  id: "saveToNotion",
  run: async (payload: NotionSavePayload) => {
    const startedAt = new Date();
    const saveId = (payload as any)?.saveId as string | undefined;
    const userId = (payload as any)?.userId as string | undefined;
    const provider = (payload as any)?.provider as string | undefined;
    const model = (payload as any)?.model as string | undefined;
    try {
      if (supabaseAdmin && saveId && userId) {
        try {
          await supabaseAdmin
            .from("notion_saves")
            .update({
              status: "running",
              started_at: startedAt,
              provider: provider || null,
              model: model || null,
            })
            .eq("id", saveId)
            .eq("user_id", userId);
        } catch {}
      }
      const result = await runSaveToNotion(payload);
      // Compute cost with latest effective rates
      let usage = (result as any)?.usage || {};
      if (supabaseAdmin && usage && (usage.prompt_tokens || usage.completion_tokens)) {
        try {
          const prov = (payload as any)?.provider;
          const mod = (payload as any)?.model;
          if (prov && mod) {
            const { data: price } = await supabaseAdmin
              .from("llm_pricing")
              .select("input_usd_per_1k, output_usd_per_1k")
              .eq("provider", prov)
              .eq("model", mod)
              .order("effective_from", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (price) {
              const inK = Number(usage.prompt_tokens || 0) / 1000;
              const outK = Number(usage.completion_tokens || 0) / 1000;
              usage.estimated_cost_usd =
                inK * Number(price.input_usd_per_1k) + outK * Number(price.output_usd_per_1k);
            }
          }
        } catch {}
      }
      if (supabaseAdmin && saveId && userId) {
        try {
          const pageId: any = (result as any)?.page?.id || null;
          const pageUrl: any =
            (result as any)?.page?.url || (result as any)?.page?.public_url || null;
          const usage = (result as any)?.usage || {};
          function extractTitleFromPage(p: any): string | null {
            try {
              const props = p?.properties || {};
              for (const [name, def] of Object.entries<any>(props)) {
                if (def && def.type === "title") {
                  const arr = Array.isArray(def.title) ? def.title : [];
                  const text = arr
                    .map((r: any) =>
                      typeof r?.plain_text === "string"
                        ? r.plain_text
                        : typeof r?.text?.content === "string"
                          ? r.text.content
                          : "",
                    )
                    .join("")
                    .trim();
                  return text || null;
                }
              }
              return null;
            } catch {
              return null;
            }
          }
          const pageTitle = extractTitleFromPage((result as any)?.page);
          await supabaseAdmin
            .from("notion_saves")
            .update({
              status: "succeeded",
              notion_page_id: pageId,
              notion_page_url: pageUrl,
              title: pageTitle,
              completed_at: new Date(),
              prompt_tokens: usage?.prompt_tokens ?? undefined,
              completion_tokens: usage?.completion_tokens ?? undefined,
              total_tokens: usage?.total_tokens ?? undefined,
              call_count: usage?.call_count ?? undefined,
              estimated_cost_usd: usage?.estimated_cost_usd ?? undefined,
            })
            .eq("id", saveId)
            .eq("user_id", userId);
        } catch {}
      }
      return result;
    } catch (e: any) {
      if (supabaseAdmin && saveId && userId) {
        try {
          await supabaseAdmin
            .from("notion_saves")
            .update({ status: "failed", error: String(e?.message || e), completed_at: new Date() })
            .eq("id", saveId)
            .eq("user_id", userId);
        } catch {}
      }
      throw e;
    }
  },
});
