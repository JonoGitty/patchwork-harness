import { defineConfig } from "vitest/config";
import { NdjsonFileReporter } from "../../../src/testing/ndjson_reporter.js";

export default defineConfig({
  test: { reporters: [new NdjsonFileReporter()] },
});
