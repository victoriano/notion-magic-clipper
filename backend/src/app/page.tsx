export default function HomePage() {
	return (
		<main style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
			<div style={{ maxWidth: 760, width: '100%', textAlign: 'center' }}>
				<div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
					<img src="/logo.svg" alt="Notion Magic Clipper" width={96} height={96} />
				</div>
				<h1 style={{ fontSize: 40, lineHeight: 1.1, margin: 0 }}>Notion Magic Clipper</h1>
				<p style={{ color: '#4b5563', margin: '10px 0 22px' }}>Clip the web to Notion with a bit of magic ✨</p>
				<div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
					<a href="https://chromewebstore.google.com/detail/notion-magic-clipper/gohplijlpngkipjghachaaepbdlfabhk" style={{ background: '#2563eb', color: '#fff', padding: '12px 16px', borderRadius: 12, fontWeight: 600, textDecoration: 'none' }}>Install extension</a>
				</div>
				<div style={{ marginTop: 18, display: 'flex', gap: 16, justifyContent: 'center', color: '#0b0b0b' }}>
					<a href="/api/notion/start" style={{ color: '#0b0b0b', textDecoration: 'none' }}>Connect Notion</a>
					<a href="/privacy" style={{ color: '#0b0b0b', textDecoration: 'none' }}>Privacy</a>
					<a href="/terms" style={{ color: '#0b0b0b', textDecoration: 'none' }}>Terms</a>
					<a href="https://github.com/victoriano/notion-magic-clipper" style={{ color: '#0b0b0b', textDecoration: 'none' }}>GitHub</a>
				</div>
			</div>
		</main>
	);
}