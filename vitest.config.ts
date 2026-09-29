import { configDefaults, defineConfig } from "vitest/config";
import { NdjsonFileReporter } from "./src/testing/ndjson_reporter.js";

// ADR-0012: the default terminal reporter is PRESERVED; the NDJSON file
// reporter is a side channel feeding the web wall / cockpit / --live.
// tests/fixtures/** is excluded — the mini-suite fixture contains a
// DELIBERATELY failing test (the reporter integration test spawns it in
// its own vitest process; a reporter that can only write green is a
// defect, so the fixture must be able to fail without failing us).
export default defineConfig({
  test: {
    reporters: ["default", new NdjsonFileReporter()],
    // Never probe live model availability under test: a mocked provider must
    // not write "reachable" for the real key (7 Sept 2026). The two files
    // that exercise probing set it back to "on" themselves.
    env: { PATCHWORK_HARNESS_AVAILABILITY_PROBE: "off" },
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
  },
});
