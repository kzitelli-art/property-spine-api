"use strict";

// Deliberate tombstone behind the existing server operator-key gate. Do not
// resolve a supplied property/run, parse a file, invoke a model or mutate data.
// Historical rows and shared extraction services remain available to their
// canonical owners; these HTTP entry points no longer confer authority.
module.exports = function legacyIngestionRetired(_req, res) {
  return res.status(410).json({
    code: "legacy_ingestion_retired",
    receipt: "This ingestion route has been retired. Open Deal Setup in your signed-in property to upload and review source files. Nothing was changed.",
    next_action: "open_deal_setup",
  });
};
