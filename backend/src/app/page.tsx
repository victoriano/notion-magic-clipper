export default function HomePage() {
	return (
		<main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
			<h1>Notion Magic Backend</h1>
			<p>Start Notion authentication:</p>
			<p>
				<a href="/api/notion/start" style={{ color: '#2563eb' }}>Connect Notion</a>
			</p>
			<hr style={{ margin: '16px 0' }} />
			<p>
				<a href="/privacy" style={{ color: '#2563eb' }}>Privacy policy</a>
			</p>
			<p>
				<a href="/terms" style={{ color: '#2563eb' }}>Terms of Use</a>
			</p>
		</main>
	);
}