// Workpaper tested at the vendor seam: the adapter's translation, the port contract over a fake
// Workpaper API, and a few sessions through the package's own module. Kit behaviour (convergence,
// deadlines, the inventory partition, recovery mechanics) is tested once in the driver package.

import { describe, expect, test } from "bun:test";
import type { CreateRequest, DriverContext } from "@sandbox-benchmarks/driver";
import type { VendorTiming } from "@sandbox-benchmarks/driver/vendor";
import { restStub, vendorContract, vendorDriver } from "@sandbox-benchmarks/driver/vendor/testing";
import { TARGET_SPEC } from "@sandbox-benchmarks/schema/target-spec";
import workpaper from "./index.ts";
import { computerName, WORKPAPER_MARKER_KEY, workpaperVendor } from "./vendor.ts";

const TEMPLATE = "starsling-toolchain-4c8g";
const context: DriverContext<"workpaper"> = {
	env: {
		WORKPAPER_API_KEY: "wpk_test0000000000000000000000000000000000000000000000",
		WORKPAPER_TEMPLATE: TEMPLATE,
	},
	artifact: { kind: "none" },
	resolvedArtifact: { kind: "none" },
};
const request: CreateRequest = {
	spec: TARGET_SPEC,
	artifact: { kind: "none" },
	deadlineMs: 300_000,
};

interface Row {
	readonly id: string;
	state: "running" | "paused";
	template: string;
	metadata: Record<string, string>;
	cpuCount: number;
	memoryMB: number;
}

const enc = new TextEncoder();
/** One Connect stream frame: flags, big-endian length, JSON. */
const frame = (value: unknown, flags = 0) => {
	const body = enc.encode(JSON.stringify(value));
	const out = new Uint8Array(5 + body.length);
	out[0] = flags;
	new DataView(out.buffer).setUint32(1, body.length);
	out.set(body, 5);
	return out;
};
const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * A fake Workpaper account: the control API under /sandboxes and each computer's agent under
 * /computers/:id (the test transport moves the Workpaper-Computer header into the path).
 */
function workpaperServer(
	options: { readonly ambiguousFirstCreate?: boolean; readonly cpuCount?: number } = {},
) {
	let firstCreate = true;
	const raw = (row: Row, token = false) => ({
		sandboxID: row.id,
		state: row.state,
		cpuCount: row.cpuCount,
		memoryMB: row.memoryMB,
		startedAt: "2026-10-13T00:00:00Z",
		endAt: "2026-10-13T03:00:00Z",
		metadata: row.metadata,
		...(token && { envdAccessToken: `token-${row.id}` }),
	});
	const stub = restStub<Row>(
		{
			"GET /v2/sandboxes": ({ rows }) => [...rows.values()].map((row) => raw(row)),
			"POST /sandboxes": ({ body, add }) => {
				const row = add({
					state: "running",
					template: body.templateID,
					metadata: body.metadata,
					cpuCount: options.cpuCount ?? 4,
					memoryMB: 8192,
				});
				if (firstCreate && options.ambiguousFirstCreate) {
					firstCreate = false;
					throw new TypeError("connection closed after remote acceptance");
				}
				firstCreate = false;
				return raw(row);
			},
			"GET /sandboxes/:id": ({ row }) => raw(row, true),
			"DELETE /sandboxes/:id": ({ row, rows }) => {
				rows.delete(row.id);
			},
			"POST /computers/:id/process.Process/Start": ({ body, run }) => {
				const json = JSON.parse(String(body).slice(5));
				const shell: string = json.process.args.at(-1);
				const { stdout, stderr, exitCode } =
					shell === "fixture" ? { stdout: "out\n", stderr: "err\n", exitCode: 7 } : run(shell);
				const parts = [
					frame({ event: { start: { pid: 1 } } }),
					frame({
						event: {
							data: {
								...(stdout && { stdout: b64(stdout) }),
								...(stderr && { stderr: b64(stderr) }),
							},
						},
					}),
					frame({ event: { end: { exitCode, exited: true } } }),
					frame({}, 2),
				];
				return new Response(Buffer.concat(parts), {
					headers: { "content-type": "application/connect+json" },
				});
			},
			"GET /computers/:id/files": ({ url, files }) => {
				const text = files.get(url.searchParams.get("path") ?? "");
				return text === undefined
					? Response.json({ message: "not found" }, { status: 404 })
					: new Response(text);
			},
			"POST /computers/:id/files": ({ url, body, files }) => {
				// A multipart body: the part's content sits between its blank line and the boundary.
				const text = String(body);
				const start = text.indexOf("\r\n\r\n") + 4;
				files.set(
					url.searchParams.get("path") ?? "",
					text.slice(start, text.lastIndexOf("\r\n--")),
				);
				return [{ path: url.searchParams.get("path") }];
			},
		},
		{ newId: (n) => `c${String(n).padStart(19, "0")}` },
	);
	// The SDK names a computer by header on the computer host; the stub routes by path.
	const fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const id = new Headers(init?.headers).get("Workpaper-Computer");
		if (id) url.pathname = `/computers/${id}${url.pathname}`;
		return stub.fetch(url.toString(), init);
	}) as typeof globalThis.fetch;
	return {
		fetch,
		rows: stub.rows,
		calls: stub.calls,
		creates: () =>
			stub.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes"),
	};
}

const FAST: Partial<VendorTiming> = { pollMs: 0, readyTimeoutMs: 500, deleteTimeoutMs: 500 };

function driverOver(server: ReturnType<typeof workpaperServer>) {
	return vendorDriver(workpaper, context, {
		vendor: workpaperVendor(context, server.fetch),
		timing: FAST,
	});
}

vendorContract("workpaper adapter", workpaper, () =>
	workpaperVendor(context, workpaperServer().fetch),
);

describe("computer names", () => {
	test("fit Workpaper's naming rule and stay distinct per marker", () => {
		const a = computerName("benchmark-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
		const b = computerName("benchmark-1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
		expect(a).toMatch(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/);
		expect(a).not.toBe(b);
	});
});

describe("Workpaper end to end through its module", () => {
	test("a session creates from the template, executes, round-trips files, is inventoried, and is destroyed", async () => {
		const server = workpaperServer();
		const driver = driverOver(server);
		const session = await driver.create(request);
		const created = server.creates()[0]?.body as {
			templateID: string;
			metadata: Record<string, string>;
		};
		expect(created.templateID).toBe(TEMPLATE);
		expect(created.metadata[WORKPAPER_MARKER_KEY]).toMatch(/^benchmark-[0-9a-f-]{36}$/);

		const result = await session.exec("fixture");
		expect(result.exit).toEqual({ kind: "exited", code: 7 });
		expect([result.stdout, result.stderr]).toEqual(["out\n", "err\n"]);
		await session.files?.writeText("/tmp/item", "saved");
		expect(await session.files?.readFile("/tmp/item")).toBe("saved");

		expect(await driver.inventory?.list()).toEqual({
			owned: [session.sandboxRef],
			foreignCount: 0,
		});
		await session.destroy();
		expect(server.rows.size).toBe(0);
		expect(await driver.inventory?.list()).toEqual({ owned: [], foreignCount: 0 });
	});

	test("the operator's other computers are foreign: never owned, never torn down", async () => {
		const server = workpaperServer();
		const driver = driverOver(server);
		server.rows.set("mine", {
			id: "mine",
			state: "paused",
			template: "workpaper-2c4g",
			metadata: {},
			cpuCount: 2,
			memoryMB: 4096,
		});
		const session = await driver.create(request);
		expect(await driver.inventory?.list()).toEqual({
			owned: [session.sandboxRef],
			foreignCount: 0,
		});
		await session.destroy();
		expect([...server.rows.keys()]).toEqual(["mine"]);
	});

	test("a computer of the wrong size is refused and torn down", async () => {
		const server = workpaperServer({ cpuCount: 2 });
		await expect(driverOver(server).create(request)).rejects.toBeDefined();
		expect(server.rows.size).toBe(0);
	});

	test("an ambiguous create is found by its marker and deleted", async () => {
		const server = workpaperServer({ ambiguousFirstCreate: true });
		await expect(driverOver(server).create(request)).rejects.toMatchObject({
			code: "create-failed",
		});
		expect(server.rows.size).toBe(0);
	});
});
