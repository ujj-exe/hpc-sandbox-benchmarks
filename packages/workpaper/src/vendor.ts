// Workpaper's vendor adapter: translation only. It states what the `workpaper` SDK's computers mean
// in the vendor port's terms; readiness, cleanup confirmation, recovery, inventory and the disk proof
// live in the driver kit (`@sandbox-benchmarks/driver/vendor`).

import type { DriverContext } from "@sandbox-benchmarks/driver";
import type { Phase, Vendor, VendorRecord } from "@sandbox-benchmarks/driver/vendor";
import { httpStatus, refusedOn } from "@sandbox-benchmarks/driver/vendor";
import { type } from "arktype";
import type { Computer } from "workpaper";
import { Workpaper, WorkpaperError } from "workpaper";

/** Workpaper computer IDs are opaque lowercase alphanumerics. */
export const WORKPAPER_COMPUTER_ID = type(/^[a-z0-9]+$/);
/** Metadata key the ownership marker travels under (the account may hold other computers). */
export const WORKPAPER_MARKER_KEY = "starsling-marker";
/** Long enough for the slowest suite's budget plus setup and collection; it stops, not deletes, after. */
const RUN_SECONDS = 3 * 60 * 60;
/** One command's synchronous bound; longer steps are detached by the kit. */
const EXEC_TIMEOUT_MS = 60_000;

/** What the adapter keeps of a computer: the SDK object itself. */
export type WorkpaperRaw = Computer;

/** A computer name from the kit's marker: names are a-z, 0-9 and -, at most 32 characters. */
export function computerName(marker: string): string {
	return `sb${marker.replace(/[^0-9a-f]/g, "").slice(0, 30)}`;
}

/**
 * A computer exists only as running or stopped (`paused`); the SDK's create returns it running. A
 * stopped one is marked `stopped` on its record: it holds no compute but is still owned and torn down.
 */
export function workpaperPhase(computer: Pick<Computer, "state">): Phase {
	return computer.state === "running" || computer.state === "paused" ? "ready" : "pending";
}

const status = httpStatus(WorkpaperError, (error) => error.status);

export function workpaperVendor(
	{ env }: Pick<DriverContext<"workpaper">, "env">,
	transport: typeof globalThis.fetch,
): Vendor<WorkpaperRaw, Computer> {
	const wp = new Workpaper({
		apiKey: env.WORKPAPER_API_KEY,
		fetch: transport,
		// The benchmark's create budget, not the SDK's 15-minute default, bounds waiting in line.
		waitSeconds: 0,
	});
	const record = (computer: Computer): VendorRecord<WorkpaperRaw> => ({
		id: computer.id,
		phase: workpaperPhase(computer),
		marker: computer.metadata[WORKPAPER_MARKER_KEY],
		stopped: computer.state === "paused",
		raw: computer,
	});
	const all = async () => (await wp.list()).map(record);

	return {
		control: {
			// The SDK's create returns once the computer is running and answering.
			create: async ({ marker }) =>
				record(
					await wp.create(computerName(marker), {
						template: env.WORKPAPER_TEMPLATE,
						timeout: RUN_SECONDS,
						metadata: { [WORKPAPER_MARKER_KEY]: marker },
					}),
				),
			get: async (id) => (await all()).find((row) => row.id === id) ?? null,
			remove: async (_id, op) => {
				const current = await op.current();
				if (!current) return "removed";
				await current.raw.delete();
				return "accepted";
			},
			absent: (error) => status(error) === 404,
			page: async () => ({ records: await all() }),
			// Shared account: an ambiguous create is found by the marker kept in its metadata.
			find: async (marker) => ({ records: (await all()).filter((row) => row.marker === marker) }),
			// Refused before a computer exists; only waiting in line or a rate limit is worth a retry.
			refused: (error) => {
				if (error instanceof WorkpaperError && error.reason === "at_capacity")
					return { retryable: true };
				return refusedOn(status, [400, 401, 402, 403, 409, 429])(error);
			},
			transient: (error) => [502, 503, 504].includes(status(error) ?? 0),
			admit: (ready) =>
				ready.raw.cpus === 4 && Math.abs(ready.raw.memoryMB - 8192) <= 819
					? undefined
					: `created ${ready.raw.cpus} vCPU / ${ready.raw.memoryMB} MB, not 4 vCPU / 8 GiB`,
		},
		data: {
			attach: (row) => row.raw,
			exec: async (computer, command, options) => {
				// The SDK runs the command under `bash -lc`, so the workload preamble's Bash features hold.
				const result = await computer.exec(command, { timeoutMs: EXEC_TIMEOUT_MS });
				options?.signal?.throwIfAborted();
				return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
			},
			files: {
				read: (computer, path) => computer.readText(path),
				write: (computer, path, text) => computer.write(path, text),
			},
		},
	};
}
