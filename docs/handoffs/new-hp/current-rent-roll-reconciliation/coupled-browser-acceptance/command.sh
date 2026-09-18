#!/bin/bash
# Coupled browser acceptance: app 1a5f257 (pinned proof, unedited) against API e808199 on the owned run32 database.
S=<scratchpad>; RT=<scratchpad>/current-rr-qb-runtime-20260913
cd $S/api-e808199 && source $S/run32/env_all.sh \
 && export NODE_PATH=$S/night/node_modules PROOF_SERVER_ROOT=$S/api-e808199 PROOF_SERVER_SHA=<hash> \
    BOOT_ENV="$(cat $S/run32/boot_env.json)" PROOF_EVIDENCE_LABEL=coupled \
    SP=$S/night API_ROOT=$S/api-e808199 APP_ROOT=$S/app-1a5f257 API=http://127.0.0.1:3111 TLS_PORT=8443 \
    CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome SHOTS=$RT/artifacts/coupled-browser \
 && node $S/run1/drive.js $S/app-1a5f257/current_rent_roll_reconciliation.browser.js \
    '{"NODE_OPTIONS":"--require '$S'/run8/ipv4_only_shim.js --require '$RT'/coupled-browser-runner.cjs"}'
