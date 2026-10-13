// The Workpaper DriverModule: the kit's driver over Workpaper's adapter, bound to the real transport
// here and nowhere else. Tests lower the same module over a fake transport through `vendorDriver`.

import { defineVendorDriver, pinned } from "@sandbox-benchmarks/driver/vendor";
import { WORKPAPER_PROVENANCE } from "./provenance.ts";
import { WORKPAPER_COMPUTER_ID, WORKPAPER_MARKER_KEY, workpaperVendor } from "./vendor.ts";

export { WORKPAPER_COMPUTER_ID };

export default defineVendorDriver("workpaper", {
	provenance: WORKPAPER_PROVENANCE,
	sandboxId: WORKPAPER_COMPUTER_ID,
	// The operator-prepared template pins 4 vCPU / 8 GiB; disk is proven after boot.
	coverage: pinned(4, 8),
	// The account may hold the operator's other computers: ownership is the metadata marker.
	account: "shared",
	timing: { controlTimeoutMs: 30_000 },
	// A create that errored after the API accepted it can still finish: empty lookups prove nothing.
	recovery: { provesAbsence: false, maxAttempts: 3 },
	markerKey: WORKPAPER_MARKER_KEY,
	vendor: (context) => workpaperVendor(context, globalThis.fetch),
});
