#!/usr/bin/env node
// scripts/bake-tally.js
//
// Reads every CSV scripts/bake-rate.html produced (one per rater — see
// its own header comment for why the file isn't a shared one), unblinds
// them (the `system` column was always there, just never shown to the
// rater — see bake-rate.html's renderRound), and prints one table per
// system: how each system's lines actually landed — LOL/smirk/nothing/bad
// counts, would-screenshot rate, and a breakdown of whatever failure
// reasons got picked. Same LOL/smirk/nothing/bad + screenshot + failure-
// reason vocabulary as scripts/bible-rate.html now (see the v4 addendum,
// section I) — this replaced the old six-tag multi-select scheme
// (funniest/most surprising/most tailored/most shareable/too random/too
// far) the CSV used to carry.
//
// Usage:
//   node scripts/bake-tally.js                    # reads every *.csv in bake/csv/
//   node scripts/bake-tally.js a.csv b.csv c.csv   # or name specific files
//
// Ratings are raw counts, not a single blended score — read the whole
// table, the same way scripts/bake.js and scripts/bake-blind.js both ask
// you to read their own output rather than trusting a script to pick a
// winner for you.

const fs = require("fs");
const path = require("path");

const RATINGS = ["lol", "smirk", "nothing", "bad"];
const FAILURE_REASONS = ["too tame", "generic", "random", "answers the text", "too long", "too far"];

// A small real CSV-line parser, not a bare split(",") — bake-rate.html
// quotes any field containing a comma, quote, or newline (RFC4180-ish,
// doubled quotes for an escaped one), and the `input` column is free text
// that regularly has commas in it ("i understand if you're upset, i just
// wanted...").
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c === "\r") {
      // skip — \r\n line endings
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.length && !(r.length === 1 && r[0] === ""); });
}

function findCsvFiles(args) {
  if (args.length) return args;
  const dir = path.join(__dirname, "..", "bake", "csv");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function (f) { return f.toLowerCase().endsWith(".csv"); })
    .map(function (f) { return path.join(dir, f); });
}

function main() {
  const files = findCsvFiles(process.argv.slice(2));
  if (!files.length) {
    console.error("No CSV files found. Put scripts/bake-rate.html's downloaded CSVs in bake/csv/, or pass file paths directly:");
    console.error("  node scripts/bake-tally.js bake/csv/alice.csv bake/csv/bob.csv");
    process.exit(1);
  }

  // system -> rating -> count
  const ratingTally = {};
  // system -> failure reason -> count (only rows that picked one)
  const failureTally = {};
  // system -> count of rows with screenshot=yes
  const screenshotTally = {};
  // system -> total rated rows (denominator for every rate below)
  const totalTally = {};
  const raters = new Set();
  let totalRows = 0;

  files.forEach(function (file) {
    const raw = fs.readFileSync(file, "utf8");
    const rows = parseCsv(raw);
    if (!rows.length) return;
    const header = rows[0].map(function (h) { return h.trim(); });
    const idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    const required = ["rater", "system", "rating"];
    const missing = required.filter(function (r) { return !(r in idx); });
    if (missing.length) {
      console.error("Skipping " + file + " — missing column(s): " + missing.join(", ") +
        " (an older bake-ratings.csv from before the v4 addendum's rating-vocabulary reset has `tag` instead of `rating` — re-rate with the current scripts/bake-rate.html rather than trying to tally it here)");
      return;
    }
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rater = r[idx.rater];
      const system = r[idx.system];
      const rating = r[idx.rating];
      if (!system || !rating) continue;
      raters.add(rater || "anonymous");
      totalRows++;
      if (!ratingTally[system]) ratingTally[system] = {};
      ratingTally[system][rating] = (ratingTally[system][rating] || 0) + 1;
      totalTally[system] = (totalTally[system] || 0) + 1;
      if (idx.screenshot !== undefined && /^(yes|true|1)$/i.test((r[idx.screenshot] || "").trim())) {
        screenshotTally[system] = (screenshotTally[system] || 0) + 1;
      }
      const failure = idx.failure !== undefined ? (r[idx.failure] || "").trim() : "";
      if (failure) {
        if (!failureTally[system]) failureTally[system] = {};
        failureTally[system][failure] = (failureTally[system][failure] || 0) + 1;
      }
    }
  });

  if (!totalRows) {
    console.log("Found " + files.length + " file(s) but no usable rows in any of them.");
    return;
  }

  console.log("bake-tally: " + files.length + " file(s), " + totalRows + " ratings, " + raters.size + " rater(s): " + Array.from(raters).join(", "));
  console.log("");

  const systems = Object.keys(totalTally).sort();
  const colWidth = 10;
  function pad(s, w) { s = String(s); return s + " ".repeat(Math.max(0, w - s.length)); }
  function pct(n, total) { return total ? Math.round((100 * n) / total) + "%" : "—"; }

  const header = "system".padEnd(8) + RATINGS.map(function (t) { return pad(t, colWidth); }).join("") +
    pad("lol%", 8) + pad("lol+smirk%", 12) + pad("shot%", 8) + "n";
  console.log(header);
  console.log("-".repeat(header.length));

  const scored = systems.map(function (s) {
    const counts = ratingTally[s] || {};
    const total = totalTally[s] || 0;
    const lolRate = counts.lol || 0;
    const lolSmirkRate = (counts.lol || 0) + (counts.smirk || 0);
    return {
      system: s, counts: counts, total: total,
      lolPct: pct(lolRate, total), lolSmirkPct: pct(lolSmirkRate, total),
      screenshotPct: pct(screenshotTally[s] || 0, total)
    };
  });
  // Highest LOL rate first — the v4 addendum's own primary acceptance
  // target (section J: "LOL >= 15%") is a rate, not a raw count, so
  // that's what orders this table too.
  scored.sort(function (a, b) { return (b.counts.lol || 0) / (b.total || 1) - (a.counts.lol || 0) / (a.total || 1); });

  scored.forEach(function (row) {
    const line = row.system.padEnd(8) +
      RATINGS.map(function (t) { return pad(row.counts[t] || 0, colWidth); }).join("") +
      pad(row.lolPct, 8) + pad(row.lolSmirkPct, 12) + pad(row.screenshotPct, 8) + row.total;
    console.log(line);
  });

  console.log("\nlol% / lol+smirk% / shot% are rates of that system's own total rated rows (n), not of the whole run — compare rates " +
    "across systems, not raw counts. v4 addendum targets (section J): lol% >= 15, lol+smirk% >= 60, shot% >= 10.");

  const anyFailures = Object.keys(failureTally).length > 0;
  if (anyFailures) {
    console.log("\n--- failure reasons (only rows where one was picked) ---\n");
    const fHeader = "system".padEnd(8) + FAILURE_REASONS.map(function (f) { return pad(f, 19); }).join("");
    console.log(fHeader);
    console.log("-".repeat(fHeader.length));
    systems.forEach(function (s) {
      const counts = failureTally[s] || {};
      console.log(s.padEnd(8) + FAILURE_REASONS.map(function (f) { return pad(counts[f] || 0, 19); }).join(""));
    });
  }
}

main();
