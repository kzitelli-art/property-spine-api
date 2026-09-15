# Reusable leasing setup — release receipt

## Scope and current status

**Verified live, September 12:** unchanged API `1320c2c5a6e52caa15de967670ed826ea1d10a84` with app `e23a36a4588cdeda10eb3d902cea4b917f68dbe9`. App deployment `dep-dainbnrm8hqs73dimq8g` succeeded Live; public health identifies1320c2c and all24 served runtime files byte-match the reviewed app commit. It adds a maintained Leasing setup view, selection of an existing property in Deal Setup, and verified download of the original retained rent roll.

The user asked that the next property fill existing shelves instead of repeating Greenery's investigation. These changes use the existing domain reads and Deal Setup commands. No database, schema, pricing, staffing, property configuration, website source or consent changes are included. This release does not establish a real property's launch acceptance.

## What staff can do

- Open **Settings → Leasing setup**, or the same door from Leasing. Review current property answers, tour setup and lease-document configuration, then enter the existing editor. Return to reload the property reads. Team and Deal Setup keep their existing doors and authority.
- In Deal Setup, choose an eligible existing property by name/address, instead of only being offered a new-property form. Attachment uses the existing scoped writer. The list is bounded and excludes properties on current deals; attaching does not grant staff access or change the active operating property.
- In the source review, request **Download original source**. The browser fetches the activation's actual retained artifact with normal staff authentication and verifies its byte size and SHA-256 before offering the file.

Missing records, access refusals and failed reads remain distinct. Old property/deal responses and late downloads are discarded after navigation or session changes. No second checklist state or readiness percentage is stored. UI and Ask keep their existing canonical data owners.

## Review and evidence

Root reviewed both app candidates against the API source at f4e59eb (documentation-only above live1320c2c). The property picker/attachment/download endpoints already exist in that live product. Classification: permanent app projections, Class1; component tests/sanitized inputs, Class3.

Leasing setup candidate b677df5: 19 counted Chromium component assertions, existing Tour Times21/0, desktop/mobile app-CSS inspection and keyboard focus checks. An independent challenge found the missing-timezone422 was rendered as an outage; the successor recognizes its canonical code and displays a setup requirement. Root simplified operator-facing wording after review.

Deal Setup candidate ca61b8b: 26 named component scenarios, existing canonical review51/0 and summary4/0. Successor aaa33f5 uses the app's shared portable Chromium runtime and counts actual completed assertions through the shared reporter: 77 passed/0 failed across29 named scenarios. Actual-CSS phone review reproduced the old190px sidebar clipping the main content; scoped Deal Setup mobile rules now provide top navigation/full-width content, wrapping and table scrolling. Desktop/mobile screenshots were inspected. Three existing owned-browser scripts had selectors updated for the explicitly named create-new button; those DB/browser scripts were not rerun by this app-only lane.

**Final combined acceptance:** exact app e23a36a, sanctioned `run_harnesses.sh`, process55950 exited0: **67 harnesses,2253 passed,0 failed,0 red**. Log: ONBOARDING_APP_ACCEPTANCE_20260912.log. The integration tree was clean and the exact pushed branch SHA was read back. The API product is unchanged; receipt/framework docs above1320c2c are not an API release.

All new component scenarios use explicit synthetic transport/read adapters. They do not prove a new live invite, actual source upload, real property attachment, or production operator journey. No sample property is used as a signed-in fallback.

## Framework still to build

The generic inventory review must happen before `read-source` materializes homes: preview original labels against canonical identity; require authorized existing-home or new-home decisions; bind them to retained evidence; revalidate on apply and confirmation. Same-text candidates still need hierarchy/provenance review. Absence from a source never authorizes retirement. This safeguard is specified and source-audited, not implemented by this release.

Automatic document/transcript-to-all-shelves intake, in-app source connection setup, designated topic review responsibility and the complete second-operator onboarding rehearsal remain open. The framework acceptance is an unfamiliar synthetic property onboarded through the ordinary app without developer-selected IDs, bespoke spreadsheet repair or direct SQL, including repeat/corrected uploads and later changes visible through UI/Ask.

## Deployment and recovery

Preflight public read matched all23 prior app files to4fd0af8 and unchanged API health1320c2c. First app deployment dep-dain9om7bikc739bvgdg failed safely at the existing packaging guard: `MISSING RUNTIME ASSET: leasing-setup.js`. The previous app remained live. Root added only `leasing-setup.js` to the Render Build Command's explicit copy list, keeping its missing-asset guard and publish directory. The same exact app commit then deployed successfully as dep-dainbnrm8hqs73dimq8g. Public verification matched24/24 assets; see ONBOARDING_RELEASE_RELEASED_20260912.json.

Recovery is Render rollback to the already-built app deployment dep-dailb0ojo6nc73fct60g (app4fd0af8), with unchanged API1320c2c. If rebuilding that earlier source instead, remove the newly added `leasing-setup.js` from the copy list first, since that source does not contain it. No schema rollback or data mutation is involved.

During release the owner supplied Claude's cfdd445 no-consent journey. Its desk-lock defect and source correction are a separate API lane, not included here. Independent QB review found one unpropagated nonlocking-read option in the bound-offer/pending-successor branch; a bounded correction and stronger authority/desk/queue proofs are in progress. A green original journey is not acceptance of that missing branch, and the Greenery retirement review does not replace its unresolved production setup decisions.
