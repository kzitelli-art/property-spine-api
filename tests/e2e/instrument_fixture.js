/* TEST FIXTURE - NOT PRODUCTION TRUTH, NOT A LEGAL INSTRUMENT.
   Builds a readable DOCX with real bytes, retains it on the shared source rail,
   and points the test property's lease configuration at that exact artifact.
   It carries no Skyline lease language and has no legal effect. */
"use strict";

module.paths.unshift(require("path").join(__dirname, "..", "..", "node_modules"));
const JSZip = require("jszip");
const { Pool } = require("pg");
const sourceArtifacts = require("../../src/onboarding/source_artifact_service");

const pool = new Pool({
  connectionString: process.env.E2E_DATABASE_URL
    || "postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e",
});

async function fixtureDocx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const paragraph = "TEST GOVERNING LEASE BODY. Fixture only. This readable retained document exists so the end-to-end proof signs exact source bytes bound to exact deal terms. It is not the Skyline form of record, is not legal proof, carries no legal terms, and has no legal effect.";
  const paragraphs = Array.from({ length: 5 }, () =>
    `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`).join("");
  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const property = (await client.query(
      "select id,lease_config from properties where name='Skyline E2E' order by created_at desc limit 1 for update"
    )).rows[0];
    const signer = (await client.query(
      "select id,name from users where name='Mike Grivna' and is_active=true limit 1"
    )).rows[0];
    if (!property || !signer) throw new Error("Skyline E2E property and Mike Grivna fixture are required");

    const buffer = await fixtureDocx();
    const stored = await sourceArtifacts.store(client, {
      scope_type: "property",
      scope_id: property.id,
      filename: "test-governing-lease.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer,
      uploaded_by_user_id: signer.id,
      authority_basis: "end-to-end fixture",
      source_as_of_date: "2026-08-22",
      artifact_kind: "lease_template",
    });
    const cfg = property.lease_config || {};
    cfg.governing_instrument = {
      form_code: "TEST-FIXTURE-FORM",
      form_version: "0-test",
      body_sha256: stored.sha256,
      source_artifact_id: stored.id,
      source_as_of_date: "2026-08-22",
    };
    cfg.execution_authority = {
      company_signer_user_ids: [String(signer.id)],
      confirmed_by_user_id: String(signer.id),
      confirmed_signer_name: signer.name,
      basis: "end-to-end fixture",
    };
    await client.query(
      "update properties set lease_config=$2::jsonb where id=$1",
      [property.id, JSON.stringify(cfg)]);
    await client.query("commit");
    console.log(`fixture: retained governing instrument ${stored.id} - sha256 ${stored.sha256}`);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
