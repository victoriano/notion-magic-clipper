// Trigger.dev task definition (named export required by the CLI)
import { task } from '@trigger.dev/sdk';
import { runSaveToNotion, type NotionSavePayload } from '@/lib/notionSaveWorker';
import { supabaseAdmin } from '@/lib/supabase';

export const saveToNotion = task({
	id: 'saveToNotion',
	run: async (payload: NotionSavePayload) => {
		const startedAt = new Date();
		const saveId = (payload as any)?.saveId as string | undefined;
		const userId = (payload as any)?.userId as string | undefined;
		try {
			if (supabaseAdmin && saveId && userId) {
				try {
					await supabaseAdmin
						.from('notion_saves')
						.update({ status: 'running', started_at: startedAt })
						.eq('id', saveId)
						.eq('user_id', userId);
				} catch {}
			}
			const result = await runSaveToNotion(payload);
			if (supabaseAdmin && saveId && userId) {
				try {
					const pageId: any = (result as any)?.page?.id || null;
					const pageUrl: any = (result as any)?.page?.url || (result as any)?.page?.public_url || null;
					await supabaseAdmin
						.from('notion_saves')
						.update({ status: 'succeeded', notion_page_id: pageId, notion_page_url: pageUrl, completed_at: new Date() })
						.eq('id', saveId)
						.eq('user_id', userId);
				} catch {}
			}
			return result;
		} catch (e: any) {
			if (supabaseAdmin && saveId && userId) {
				try {
					await supabaseAdmin
						.from('notion_saves')
						.update({ status: 'failed', error: String(e?.message || e), completed_at: new Date() })
						.eq('id', saveId)
						.eq('user_id', userId);
				} catch {}
			}
			throw e;
		}
	},
});


