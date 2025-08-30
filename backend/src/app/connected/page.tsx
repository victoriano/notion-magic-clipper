export default function ConnectedPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const param = searchParams?.workspace_id;
  const workspaceId = Array.isArray(param) ? param[0] : param || "";
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Connected to Notion</h1>
      <p>Success! Your Notion workspace is now connected.</p>
      {workspaceId ? (
        <p style={{ color: "#666" }}>
          Workspace ID: <code>{workspaceId}</code>
        </p>
      ) : null}
      <p>You can close this tab and return to the extension.</p>
      <p>
        <a href="/" style={{ color: "#2563eb" }}>
          Go to home
        </a>
      </p>
    </main>
  );
}
