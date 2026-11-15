/** `CREATE SECRET (TYPE salesforce, …)`: the org URL plus one OAuth flow. */

import { field, schema, utf8 } from "@query-farm/vgi";
import { SECRET_TYPE } from "./sf/client.ts";

const doc = (text: string) => new Map([["vgi_doc", text]]);
const redacted = (text: string) =>
  new Map([
    ["redact", "true"],
    ["vgi_doc", text],
  ]);

export const SALESFORCE_SECRET_TYPE = {
  name: SECRET_TYPE,
  description:
    "Salesforce org (instance_url) plus OAuth: JWT bearer (client_id + username + private_key), client credentials " +
    "(client_id + client_secret), refresh token, or a pre-issued access_token. Username/password is not supported.",
  schema: schema(
    [
      field(
        "instance_url",
        utf8(),
        true,
        doc("The org's My Domain URL, e.g. https://acme.my.salesforce.com (http:// only for 127.0.0.1/localhost)."),
      ),
      field(
        "login_url",
        utf8(),
        true,
        doc(
          "OAuth host for JWT bearer / refresh token: https://login.salesforce.com (default) or https://test.salesforce.com for sandboxes.",
        ),
      ),
      field("api_version", utf8(), true, doc("REST API version to pin, e.g. '64.0' (the default).")),
      field("client_id", utf8(), true, doc("Connected app consumer key.")),
      field("username", utf8(), true, doc("JWT bearer: the Salesforce username to act as (the integration user).")),
      field(
        "private_key",
        utf8(),
        true,
        redacted("JWT bearer: the connected app certificate's RSA private key (PEM)."),
      ),
      field(
        "client_secret",
        utf8(),
        true,
        redacted("Client credentials (or refresh token) flow: the consumer secret."),
      ),
      field(
        "refresh_token",
        utf8(),
        true,
        redacted("Refresh token flow: an OAuth refresh token for the connected app."),
      ),
      field(
        "access_token",
        utf8(),
        true,
        redacted("A pre-issued session/access token (not refreshed; for quick tests)."),
      ),
    ],
    new Map([["vgi_doc_url", "https://github.com/Query-farm/vgi-salesforce#connect-an-org"]]),
  ),
};
