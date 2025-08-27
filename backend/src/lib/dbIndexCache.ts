import { supabaseAdmin } from '@/lib/supabase';
import crypto from 'crypto';

export type CachedDatabase = {
	id: string;
	title: string;
	iconEmoji?: string;
	url: string;
	workspaceId?: string;
	lastEditedTime?: string;
};

export type IndexCacheResult = {
	databases: CachedDatabase[];
	version: string | null;
	stale: boolean;
};

const INDEX_TTL_MS = 10 * 60 * 1000; // 10 minutes

function computeIndexVersion(databases: CachedDatabase[]): string {
	const stable = databases
		.map((d) => ({ id: d.id, title: d.title, iconEmoji: d.iconEmoji, url: d.url, workspaceId: d.workspaceId || null }))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const json = JSON.stringify(stable);
	return crypto.createHash('sha1').update(json).digest('hex');
}

export async function readIndexCache(userId: string): Promise<IndexCacheResult> {
	if (!supabaseAdmin) return { databases: [], version: null, stale: false };
	const { data, error } = await supabaseAdmin
		.from('notion_db_index')
		.select('db_id,title,icon_emoji,url,workspace_id,updated_at,version')
		.eq('user_id', userId)
		.order('updated_at', { ascending: false });
	if (error) return { databases: [], version: null, stale: false };
	const databases: CachedDatabase[] = (data || []).map((r: any) => ({
		id: r.db_id,
		title: r.title || '(Untitled)',
		iconEmoji: r.icon_emoji || undefined,
		url: r.url,
		workspaceId: r.workspace_id || undefined,
	}));
	if (databases.length === 0) return { databases, version: null, stale: false };
	const version = (data?.[0]?.version as string) || computeIndexVersion(databases);
	const newestUpdatedAt = data?.[0]?.updated_at ? new Date(data[0].updated_at).getTime() : Date.now();
	const stale = Date.now() - newestUpdatedAt > INDEX_TTL_MS;
	return { databases, version, stale };
}

export async function refreshIndexCache(userId: string): Promise<IndexCacheResult> {
	if (!supabaseAdmin) return { databases: [], version: null, stale: false };
	const { data, error } = await supabaseAdmin
		.from('notion_connections')
		.select('access_token,workspace_id')
		.eq('user_id', userId);
	if (error) return { databases: [], version: null, stale: false };
	const connections: { token: string; workspaceId: string | null }[] = (data || [])
		.map((r: any) => ({ token: r.access_token as string, workspaceId: (r.workspace_id as string) || null }))
		.filter((r: { token: string; workspaceId: string | null }) => !!r.token);
	if (connections.length === 0) return { databases: [], version: null, stale: false };

	const body = {
		query: '',
		filter: { property: 'object', value: 'database' },
		sort: { direction: 'ascending', timestamp: 'last_edited_time' },
	};

	const per = await Promise.all(
		connections.map(async ({ token: tok, workspaceId }) => {
			try {
				const resp = await fetch('https://api.notion.com/v1/search', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${tok}`,
						'Notion-Version': '2022-06-28',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(body),
				});
				if (!resp.ok) throw new Error('notion');
				const j = await resp.json();
				const results: CachedDatabase[] = (j.results || []).map((item: any) => {
					const title = (item.title || []).map((t: any) => t.plain_text).join('') || '(Untitled)';
					const iconEmoji = item?.icon?.type === 'emoji' ? item.icon.emoji : undefined;
					const url = item?.url || `https://www.notion.so/${String(item?.id || '').replace(/-/g, '')}`;
					const lastEditedTime = item?.last_edited_time || undefined;
					return { id: item.id, title, iconEmoji, url, workspaceId: workspaceId || undefined, lastEditedTime };
				});
				return results;
			} catch {
				return [];
			}
		})
	);

	const byId = new Map<string, CachedDatabase>();
	for (const list of per) {
		for (const db of list) {
			if (!byId.has(db.id)) byId.set(db.id, db);
		}
	}
	const databases = Array.from(byId.values());
	const version = computeIndexVersion(databases);

	// Upsert cache rows in Supabase
	if (databases.length > 0) {
		await supabaseAdmin
			.from('notion_db_index')
			.upsert(
				databases.map((d) => ({
					user_id: userId,
					db_id: d.id,
					title: d.title,
					icon_emoji: d.iconEmoji || null,
					url: d.url,
					workspace_id: d.workspaceId || null,
					last_edited_time: d.lastEditedTime ? new Date(d.lastEditedTime).toISOString() : null,
					version,
				})),
				{ onConflict: 'user_id,db_id' }
			);

		// Delete rows no longer present (use explicit id list to avoid accidental mass delete)
		const ids = databases.map((d) => d.id);
		const { data: existing, error: exErr } = await supabaseAdmin
			.from('notion_db_index')
			.select('db_id')
			.eq('user_id', userId);
		if (!exErr) {
			const existingIds = (existing || []).map((r: any) => r.db_id as string);
			const toDelete = existingIds.filter((eid: string) => !ids.includes(eid));
			if (toDelete.length > 0) {
				await supabaseAdmin
					.from('notion_db_index')
					.delete()
					.eq('user_id', userId)
					.in('db_id', toDelete);
			}
		}
	}

	return { databases, version, stale: false };
}

