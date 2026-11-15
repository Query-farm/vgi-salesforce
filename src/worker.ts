/**
 * The worker entry point.
 *
 *   bin/vgi-salesforce-worker                      # stdio: what DuckDB launches by default
 *   bin/vgi-salesforce-worker --http --port 8000   # HTTP: for Docker / hosted deploys
 *   bin/vgi-salesforce-worker --help
 *
 * Attach it from DuckDB:
 *
 *   ATTACH 'salesforce' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-salesforce-worker');
 */

import { CATALOG } from "./catalog.ts";
import { serve } from "./cli.ts";
import { CATALOG_DOC_LLM, SOURCE_URL, VERSION } from "./meta.ts";

if (import.meta.main) {
  serve(CATALOG, { version: VERSION, doc: CATALOG_DOC_LLM, repositoryUrl: SOURCE_URL });
}
