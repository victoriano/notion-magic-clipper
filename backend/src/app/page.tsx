export default function HomePage() {
	return (
		<main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
			<h1>Notion Magic Backend</h1>
			<p>Start Notion authentication:</p>
			<p>
				<a href="/api/notion/start" style={{ color: '#2563eb' }}>Connect Notion</a>
			</p>
		</main>
	);
}