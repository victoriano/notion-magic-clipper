export default function PrivacyPolicyPage() {
	return (
		<main style={{ padding: 24, maxWidth: 840, margin: '0 auto', fontFamily: 'system-ui, sans-serif', lineHeight: 1.6 }}>
			<h1>Privacy Policy</h1>
			<p><em>Effective date: {new Date().toISOString().slice(0, 10)}</em></p>

			<p>
				This extension and its companion backend ("Service") help you save the current web page into your Notion
				database and optionally use an AI model to auto-fill properties. We collect and process the minimum data
				necessary to provide this functionality.
			</p>

			<h2>What data we collect</h2>
			<ul>
				<li>
					<b>Website content (page you choose to save).</b> When you click the extension, we read the current tab to
					extract the page URL, title, metadata, selected text, a short text sample, article content (when available),
					and candidate images.
				</li>
				<li>
					<b>Authentication information you provide.</b> You may optionally store API keys (OpenAI / Google AI) and
					link your Notion workspace via OAuth. These credentials are stored locally in the extension's
					<code>chrome.storage.local</code>. Workspace access tokens may be retrieved from the backend after you
					complete the OAuth flow.
				</li>
				<li>
					<b>Basic account status (from backend).</b> After logging in, the popup may display that you are logged in
					(e.g., your Notion account email). This is fetched from the backend to show your status and is not used for
					tracking.
				</li>
			</ul>

			<h2>How we use data</h2>
			<ul>
				<li>Send the selected page content to Notion to create a page in your chosen database.</li>
				<li>Optionally send text snippets to the AI provider you configure (OpenAI or Google) to map content to Notion properties or generate concise page blocks, if enabled.</li>
				<li>Perform OAuth with Notion to link your workspace and obtain tokens needed to save pages on your behalf.</li>
			</ul>

			<h2>Data sharing</h2>
			<p>Data may be transmitted only to the following services:</p>
			<ul>
				<li><b>Notion API</b> (api.notion.com) — to search databases and create pages.</li>
				<li><b>AI provider (optional)</b> — OpenAI (api.openai.com) or Google AI (generativelanguage.googleapis.com) when you enable model-assisted filling.</li>
				<li><b>Backend</b> — for OAuth flows (link/disconnect workspaces) and to fetch workspace-scoped tokens.</li>
			</ul>

			<h2>Storage and retention</h2>
			<ul>
				<li>
					<b>Local only.</b> Preferences, API keys, and workspace tokens are stored locally in the extension
					storage on your device and remain until you clear them (Settings → Clear local data) or uninstall the extension.
				</li>
				<li>
					<b>No analytics and no ads.</b> We do not sell user data or use it for advertising or credit decisions.
				</li>
			</ul>

			<h2>Security</h2>
			<ul>
				<li>We never execute remote code. All scripts are packaged with the extension and declared in the manifest.</li>
				<li>Credentials are transmitted only to the selected providers over HTTPS.</li>
			</ul>

			<h2>Your choices</h2>
			<ul>
				<li>You can use the extension without AI by not providing any AI key.</li>
				<li>You can clear all locally stored data from the Tokens page in the popup at any time.</li>
				<li>You can disconnect workspaces from the Tokens page or via your Notion account.</li>
			</ul>

			<h2>Contact</h2>
			<p>
				For questions or requests, please open an issue on our GitHub repository.
			</p>

			<h2>Changes</h2>
			<p>
				We may update this policy. We will post any changes on this page and update the effective date above.
			</p>
		</main>
	);
}


