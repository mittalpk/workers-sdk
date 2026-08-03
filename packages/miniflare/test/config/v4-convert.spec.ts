import { describe, test } from "vitest";
import { convertV4MiniflareOptions } from "../../src/config/v4-convert";

describe("convertV4MiniflareOptions", () => {
	test("converts local, external, and unbound durable objects", ({
		expect,
	}) => {
		const converted = convertV4MiniflareOptions({
			name: "worker",
			compatibilityDate: "2026-01-01",
			script: "export default {};",
			durableObjects: {
				LOCAL: {
					className: "LocalObject",
					useSQLite: true,
					unsafeUniqueKey: "local-key",
					unsafePreventEviction: true,
				},
				EXTERNAL: {
					className: "ExternalObject",
					scriptName: "external-worker",
				},
			},
			additionalUnboundDurableObjects: [
				{ className: "UnboundObject", useSQLite: false },
			],
		});

		expect(converted.workers[0].config.env).toMatchObject({
			LOCAL: {
				type: "durable-object",
				workerName: "worker",
				exportName: "LocalObject",
			},
			EXTERNAL: {
				type: "durable-object",
				workerName: "external-worker",
				exportName: "ExternalObject",
			},
		});
		expect(converted.workers[0].config.exports).toMatchObject({
			LocalObject: {
				type: "durable-object",
				storage: "sqlite",
				unsafeUniqueKey: "local-key",
				unsafePreventEviction: true,
			},
			UnboundObject: {
				type: "durable-object",
				storage: "legacy-kv",
			},
		});
		expect(converted.workers[0].config.exports).not.toHaveProperty(
			"ExternalObject"
		);
	});

	test("converts module source and representative bindings", ({ expect }) => {
		const converted = convertV4MiniflareOptions({
			name: "worker",
			script: "export default {};",
			modules: true,
			bindings: { TEXT: "value", JSON: { nested: true } },
			kvNamespaces: ["KV"],
			d1Databases: { DB: "database" },
			r2Buckets: {
				R2: {
					id: "bucket",
					s3Credentials: {
						accessKeyId: "access-key",
						secretAccessKey: "secret-key",
					},
				},
			},
			queueProducers: { QUEUE: { queueName: "queue" } },
			queueConsumers: { queue: { maxBatchSize: 10 } },
			serviceBindings: { SERVICE: "other-worker" },
			assets: { directory: "./public", binding: "ASSETS" },
			workflows: {
				WORKFLOW: { name: "workflow", className: "Workflow" },
			},
		});

		expect(converted.workers[0].config).toMatchObject({
			type: "worker",
			name: "worker",
			compatibilityDate: "2023-07-24",
			manifest: {
				mainModule: "script-0.mjs",
				modules: {
					"script-0.mjs": {
						type: "esm",
						contents: "export default {};",
					},
				},
			},
			assets: { directory: "./public" },
			env: {
				TEXT: { type: "text", value: "value" },
				JSON: { type: "json", value: { nested: true } },
				KV: { type: "kv", id: "KV" },
				DB: { type: "d1", id: "database" },
				R2: {
					type: "r2",
					name: "bucket",
					s3Credentials: {
						accessKeyId: "access-key",
						secretAccessKey: "secret-key",
					},
				},
				QUEUE: { type: "queue", name: "queue" },
				SERVICE: { type: "worker", workerName: "other-worker" },
				ASSETS: { type: "assets" },
				WORKFLOW: {
					type: "workflow",
					name: "workflow",
					workerName: "worker",
					exportName: "Workflow",
				},
			},
			exports: {
				Workflow: { type: "workflow", name: "workflow" },
			},
			triggers: [{ type: "queue", name: "queue", maxBatchSize: 10 }],
		});
	});

	test("converts multiple workers", ({ expect }) => {
		const converted = convertV4MiniflareOptions({
			workers: [
				{ name: "a", script: "export default {};", modules: true },
				{ name: "b", script: "addEventListener('fetch', () => {});" },
			],
		});

		expect(converted.workers).toHaveLength(2);
		expect(converted.workers[0].config.manifest).toBeDefined();
		expect(converted.workers[1].legacy?.serviceWorkerScript).toBe(
			"addEventListener('fetch', () => {});"
		);
	});
});
