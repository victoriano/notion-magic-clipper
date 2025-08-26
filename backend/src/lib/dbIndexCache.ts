import { supabaseAdmin } from '@/lib/supabase';
import crypto from 'crypto';

export type CachedDatabase = {
	id: string;
	title: string;
	iconEmoji?: string;
	url: string;
};

export type IndexCacheResult = {
	databases: CachedDatabase[];
	version: string | null;
	stale: boolean;
};

const INDEX_TTL_MS = 10 * 60 * 1000; // 10 minutes

function computeIndexVersion(databases: CachedDatabase[]): string {
	const stable = databases
		.map((d) => ({ id: d.id, title: d.title, iconEmoji: d.iconEmoji, url: d.url }))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const json = JSON.stringify(stable);
	return crypto.createHash('sha1').update(json).digest('hex');
}

export async function readIndexCache(userId: string): Promise<IndexCacheResult> {
	if (!supabaseAdmin) return { databases: [], version: null, stale: false };
	const { data, error } = await supabaseAdmin
		.from('notion_db_index')
		.select('db_id,title,icon_emoji,url,updated_at,version')
		.eq('user_id', userId)
		.order('updated_at', { ascending: false });
	if (error) return { databases: [], version: null, stale: false };
	const databases: CachedDatabase[] = (data || []).map((r: any) => ({
		id: r.db_id,
		title: r.title || '(Untitled)',
		iconEmoji: r.icon_emoji || undefined,
		url: r.url,
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
		.select('access_token')
		.eq('user_id', userId);
	if (error) return { databases: [], version: null, stale: false };
	const tokens: string[] = (data || []).map((r: any) => r.access_token).filter(Boolean);
	if (tokens.length === 0) return { databases: [], version: null, stale: false };

	const body = {
		query: '',
		filter: { property: 'object', value: 'database' },
		sort: { direction: 'ascending', timestamp: 'last_edited_time' },
	};

	const per = await Promise.all(
		tokens.map(async (tok: string) => {
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
					return { id: item.id, title, iconEmoji, url };
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
					version,
				})),
				{ onConflict: 'user_id,db_id' }
			);

		// Delete rows no longer present
		const ids = databases.map((d) => d.id);
		await supabaseAdmin
			.from('notion_db_index')
			.delete()
			.eq('user_id', userId)
			.neq('db_id', ids.length === 0 ? '__none__' : ids[0])
			.not('db_id', 'in', `(${ids.map((id) => `'${id}'`).join(',') || ''})`);
	}

	return { databases, version, stale: false };
}

