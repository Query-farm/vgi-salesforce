/**
 * The worker entry point.
 *
 *   bin/vgi-salesforce-worker                      # stdio: what DuckDB launches by default
 *   bin/vgi-salesforce-worker --http --port 8000   # HTTP: for Docker / hosted deploys
 *
 *   ATTACH 'salesforce' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-salesforce-worker', OBJECTS 'Account,Opportunity');
 */

import { CATALOG, SalesforceCatalog } from "./catalog.ts";
import { serve } from "./cli.ts";
import { CATALOG_DOC_LLM, SOURCE_URL, VERSION } from "./meta.ts";

if (import.meta.main) {
  serve(CATALOG, {
    version: VERSION,
    doc: CATALOG_DOC_LLM,
    repositoryUrl: SOURCE_URL,
    catalogInterface: (catalog, registry) => new SalesforceCatalog(catalog, registry),
  });
}
