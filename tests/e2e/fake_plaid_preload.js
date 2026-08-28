/* E2E-only Plaid verification-key transport. The product still calls the
   official SDK method; this preload prevents provider traffic and returns a
   realistic Plaid JWK response for locally signed webhook JWTs. */
"use strict";

const Module = require("module");
const keys = require("./plaid_webhook_test_keys");
const originalLoad = Module._load;

Module._load = function loadWithFakePlaid(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request !== "plaid") return loaded;
  class E2EPlaidApi extends loaded.PlaidApi {
    async webhookVerificationKeyGet({ key_id: kid }) {
      if (kid === "fetch-fails") throw new Error("E2E Plaid key fetch refused");
      return {
        data: {
          key: {
            ...keys.TRUSTED_PUBLIC,
            alg: "ES256", kid, use: "sig",
            created_at: Math.floor(Date.now() / 1000) - 60,
            expired_at: null,
          },
        },
      };
    }
  }
  return { ...loaded, PlaidApi: E2EPlaidApi };
};
