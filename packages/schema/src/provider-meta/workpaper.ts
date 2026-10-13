import { defineProviderMeta } from "../provider-meta.ts";

export default defineProviderMeta("workpaper", {
	displayName: "Workpaper",
	vendor: "Workpaper",
	website: "https://workpaper.co",
	sdkPackage: "workpaper",
	artifact: { kind: "none" },
	inputs: ["WORKPAPER_API_KEY", { name: "WORKPAPER_TEMPLATE", source: { kind: "variable" } }],
	isolation: {
		class: "microVM",
		technology: "Firecracker microVM",
		notes:
			"Each computer is a Firecracker microVM with its own kernel. The benchmark template is the shared Debian toolchain image on Workpaper's large size (4 vCPU / 8 GiB), prepared by the operator and pinned by WORKPAPER_TEMPLATE.",
	},
	pricing: {
		model: "published",
		components: [
			{
				id: "large",
				resource: "cpu_memory",
				billingBasis: "provisioned",
				vendorUnit: "large computer",
				usdPerUnitHour: 0.02,
				quantityRule: { kind: "linear", dimension: "vcpus", unitsPerTargetUnit: 0.25 },
				notes:
					"The published large size (4 vCPU / 8 GB) is $0.020/hr while running; small (2 vCPU / 4 GB) is $0.010/hr.",
			},
		],
		targetHourlyCost: { kind: "exact", componentIds: ["large"] },
		notes:
			"Per-second billing while a computer runs; a stopped computer keeps its disk and memory and costs nothing. The $15/mo Pro plan is returned in full as usage credit and is recorded as plan metadata, not a compute discount.",
		sources: [
			{ label: "Workpaper pricing", url: "https://workpaper.co/#pricing", checkedAt: "2026-10-13" },
		],
		adjustments: [
			{
				kind: "fee",
				plan: "Pro",
				resource: "plan",
				quantity: 15,
				unit: "USD/month",
				scope: "monthly",
				notes: "Returned in full as usage credit.",
			},
		],
	},
	maturity: {
		status: "beta",
		notes:
			"Driver over the published `workpaper` SDK: create from the operator-prepared template, readiness, command exec, files, inventory, marker lookup and teardown. The credential's account may hold other computers; ownership is the benchmark marker stored in each computer's metadata.",
	},
	// Commands run as the computer's unprivileged `user`.
	runtimeIdentity: "unprivileged",
	specPinning: "fixed",
	transport: {
		streaming: false,
		syncCapMs: 60_000,
		detachedPoll: true,
	},
});
