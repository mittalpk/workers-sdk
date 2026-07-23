// @ts-expect-error resolved at runtime by a vitest alias
import { makeBinding } from "@workflows-wrapped-binding-under-test";
import { test } from "vitest";

test("blocks recreation after persisted deletion fails", async ({ expect }) => {
	let created = false;
	const workflow = makeBinding({
		binding: {
			create: () => {
				created = true;
				return Promise.resolve({ id: "cleanup-failed" });
			},
			unsafeGetInstanceStorageId: (id: string) => Promise.resolve(id),
		},
		MINIFLARE_LOOPBACK: {
			fetch: () => Promise.resolve(new Response(null, { status: 500 })),
		},
		MINIFLARE_WORKFLOW_NAME: "workflow",
	});

	await expect(workflow.create({ id: "cleanup-failed" })).rejects.toThrow(
		"Failed to wait for persisted workflow instance 'cleanup-failed' deletion"
	);
	expect(created).toBe(false);
});

test("reports persisted batch deletion failures per instance", async ({
	expect,
}) => {
	const abortedIds: string[] = [];
	const fetchedUrls: string[] = [];
	const workflow = makeBinding({
		binding: {
			deleteBatch: () =>
				Promise.resolve({
					deleted: [
						{ id: "cleanup-failed" },
						{ id: "deleted" },
						{ id: "cleanup-failed" },
					],
					errors: [
						{
							id: "missing",
							code: 10400,
							message: "workflows.api.error.instance.not_found",
						},
					],
				}),
			unsafeAbort: (id: string) => {
				abortedIds.push(id);
				return Promise.resolve();
			},
			unsafeGetInstanceStorageId: (id: string) => Promise.resolve(id),
		},
		MINIFLARE_LOOPBACK: {
			fetch: (url: string) => {
				fetchedUrls.push(url);
				return Promise.resolve(
					new Response(null, {
						status: url.includes("/cleanup-failed") ? 500 : 204,
					})
				);
			},
		},
		MINIFLARE_WORKFLOW_NAME: "workflow",
	});

	await expect(
		workflow.deleteBatch([
			"cleanup-failed",
			"missing",
			"deleted",
			"cleanup-failed",
		])
	).resolves.toEqual({
		deleted: [{ id: "deleted" }],
		errors: [
			{
				id: "cleanup-failed",
				code: 10001,
				message: "workflows.api.error.internal_server",
			},
			{
				id: "missing",
				code: 10400,
				message: "workflows.api.error.instance.not_found",
			},
			{
				id: "cleanup-failed",
				code: 10001,
				message: "workflows.api.error.internal_server",
			},
		],
	});
	expect(abortedIds).toEqual(["missing"]);
	expect(
		fetchedUrls.map((url) => new URL(url).pathname.split("/").at(-1)).sort()
	).toEqual(["cleanup-failed", "deleted", "missing"]);
});
