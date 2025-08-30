import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase";

export type SimplifiedProperty = {
  id: string;
  type: string;
  description?: string;
  options?: string[];
  format?: string;
  hints?: { image_like?: boolean };
  writable: boolean;
};

export type SimplifiedSchema = {
  db_id: string;
  title_prop: string | null;
  url_prop: string | null;
  properties: Record<string, SimplifiedProperty>;
  version: string; // sha1 of simplified schema excluding updated_at
  updated_at: string; // ISO string
};

export type SchemaCacheRow = {
  user_id: string;
  db_id: string;
  workspace_id: string | null;
  raw: any;
  simplified: SimplifiedSchema;
  title_prop: string | null;
  url_prop: string | null;
  updated_at: string;
  version: string;
};

export type SchemaCacheResult = {
  db_id: string;
  version: string | null;
  updated_at: string | null;
  schema: any | null; // shape controlled by caller (simplified or raw)
  stale: boolean;
};

const SCHEMA_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isReadOnlyType(t: string): boolean {
  return t === "rollup" || t === "formula" || t === "created_time" || t === "last_edited_time";
}

export function simplifySchema(notionDb: any): Omit<SimplifiedSchema, "version" | "updated_at"> {
  const dbId = String(notionDb?.id || "");
  const props = (notionDb && notionDb.properties) || {};
  let titleProp: string | null = null;
  let urlProp: string | null = null;

  const simplifiedProps: Record<string, SimplifiedProperty> = {};
  for (const [name, def] of Object.entries<any>(props)) {
    const type = String(def?.type || "");
    const id = String(def?.id || "");
    if (!titleProp && type === "title") titleProp = name;
    if (!urlProp && type === "url") urlProp = name;

    const base: SimplifiedProperty = {
      id,
      type,
      writable: !isReadOnlyType(type),
    };
    try {
      const desc = typeof def?.description === "string" ? def.description.trim() : "";
      if (desc) base.description = desc;
    } catch {}
    if (type === "select" || type === "multi_select" || type === "status") {
      try {
        const optArr = def?.[type]?.options || [];
        base.options = (Array.isArray(optArr) ? optArr : [])
          .map((o: any) => (typeof o?.name === "string" ? o.name : null))
          .filter((n: string | null) => !!n) as string[];
      } catch {}
    }
    if (type === "number") {
      try {
        const fmt = def?.number?.format;
        if (typeof fmt === "string" && fmt) base.format = fmt;
      } catch {}
    }
    if (type === "files") {
      const imageLike = /poster|cover|thumb|thumbnail|image|artwork|screenshot/i.test(name);
      if (imageLike) base.hints = { ...(base.hints || {}), image_like: true };
    }
    simplifiedProps[name] = base;
  }

  return {
    db_id: dbId,
    title_prop: titleProp,
    url_prop: urlProp,
    properties: simplifiedProps,
  };
}

function computeSchemaVersion(simplified: Omit<SimplifiedSchema, "version" | "updated_at">): string {
  const stable = JSON.stringify(simplified);
  return crypto.createHash("sha1").update(stable).digest("hex");
}

export async function readSchemaCache(
  userId: string,
  dbId: string,
  shape: "simplified" | "raw" = "simplified",
): Promise<SchemaCacheResult> {
  if (!supabaseAdmin)
    return { db_id: dbId, version: null, updated_at: null, schema: null, stale: false };
  const { data, error } = await supabaseAdmin
    .from("notion_db_schema")
    .select("db_id, updated_at, version, simplified, raw")
    .eq("user_id", userId)
    .eq("db_id", dbId)
    .maybeSingle();
  if (error || !data)
    return { db_id: dbId, version: null, updated_at: null, schema: null, stale: false };
  const updatedAtMs = data.updated_at ? new Date(data.updated_at as any).getTime() : Date.now();
  const stale = Date.now() - updatedAtMs > SCHEMA_TTL_MS;
  const schema = shape === "raw" ? (data as any).raw : (data as any).simplified;
  return {
    db_id: data.db_id,
    version: (data as any).version || null,
    updated_at: (data as any).updated_at || null,
    schema: schema || null,
    stale,
  };
}

async function getAccessibleDatabase(
  userId: string,
  dbId: string,
): Promise<{ db: any; token: string; workspaceId: string | null } | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("notion_connections")
    .select("access_token, workspace_id")
    .eq("user_id", userId);
  if (error) return null;
  const connections: { token: string; workspaceId: string | null }[] = (data || [])
    .map((r: any) => ({ token: r.access_token as string, workspaceId: r.workspace_id || null }))
    .filter((r) => !!r.token);
  if (connections.length === 0) return null;
  for (const conn of connections) {
    try {
      const db = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
        headers: {
          Authorization: `Bearer ${conn.token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
      }).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      });
      return { db, token: conn.token, workspaceId: conn.workspaceId };
    } catch {}
  }
  return null;
}

export async function refreshSchemaCache(
  userId: string,
  dbId: string,
): Promise<{ simplified: SimplifiedSchema; raw: any; version: string }> {
  if (!supabaseAdmin) throw new Error("Server misconfigured");
  const found = await getAccessibleDatabase(userId, dbId);
  if (!found) throw new Error("Database not accessible with linked workspaces");
  const { db, workspaceId } = found;
  const simpBase = simplifySchema(db);
  const version = computeSchemaVersion(simpBase);
  const simplified: SimplifiedSchema = {
    ...simpBase,
    version,
    updated_at: new Date().toISOString(),
  };

  await supabaseAdmin
    .from("notion_db_schema")
    .upsert(
      {
        user_id: userId,
        db_id: dbId,
        workspace_id: workspaceId,
        raw: db,
        simplified,
        title_prop: simplified.title_prop,
        url_prop: simplified.url_prop,
        version,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,db_id" },
    );

  return { simplified, raw: db, version };
}


