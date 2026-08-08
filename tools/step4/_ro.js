/*  The proven read-only guard, shared with the activation tools.
 *  Re-exported rather than copied: two copies of a safety guard is two
 *  places for it to rot, and the activation version already carries the
 *  two lessons this repo paid for (probe BEFORE any read; SAVEPOINT so
 *  the probe cannot poison the transaction).  */
"use strict";
module.exports = require("../activation/_readonly.js");
