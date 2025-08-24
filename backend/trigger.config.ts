// @ts-nocheck
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
	project: process.env.TRIGGER_PROJECT_ID || process.env.TRIGGER_PROJECT_REF || "",
	// Tasks live under src/trigger (the CLI auto-discovers files)
	maxDuration: "15m",
});


