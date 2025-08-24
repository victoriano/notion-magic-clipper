// Trigger.dev task definition (named export required by the CLI)
import { task } from '@trigger.dev/sdk';
import { runSaveToNotion, type NotionSavePayload } from '@/lib/notionSaveWorker';

export const saveToNotion = task({
	id: 'saveToNotion',
	run: async (payload: NotionSavePayload) => {
		return await runSaveToNotion(payload);
	},
});


