#!/usr/bin/env node
// scripts/bake-tally.js
//
// Reads every CSV scripts/bake-rate.html produced (one per rater — see
// its own header comment for why the file isn't a shared one), unblinds
// them (the `system` column was always there, just never shown to the
// rater — see bake-rate.html's renderRound), and prints one table per
// system: how many times each tag landed on one of its lines, across
// every rater and every input.
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

const POSITIVE_TAGS = ["funniest", "most surprising", "most tailored", "most shareable"];
const NEGATIVE_TAGS = ["too random", "too far"];
const ALL_TAGS = POSITIVE_TAGS.concat(NEGATIVE_TAGS);

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

  // system -> tag -> count
  const tally = {};
  // system -> input -> Set(raters who tagged something on it) — not used
  // for scoring, just so the summary can show how many distinct rater×
  // input judgments actually landed per system.
  const seenJudgments = {};
  const raters = new Set();
  let totalRows = 0;

  files.forEach(function (file) {
    const raw = fs.readFileSync(file, "utf8");
    const rows = parseCsv(raw);
    if (!rows.length) return;
    const header = rows[0].map(function (h) { return h.trim(); });
    const idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    const required = ["rater", "system", "tag"];
    const missing = required.filter(function (r) { return !(r in idx); });
    if (missing.length) {
      console.error("Skipping " + file + " — missing column(s): " + missing.join(", "));
      return;
    }
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rater = r[idx.rater];
      const system = r[idx.system];
      const tag = r[idx.tag];
      if (!system || !tag) continue;
      raters.add(rater || "anonymous");
      totalRows++;
      if (!tally[system]) tally[system] = {};
      tally[system][tag] = (tally[system][tag] || 0) + 1;
      if (!seenJudgments[system]) seenJudgments[system] = new Set();
      seenJudgments[system].add((rater || "anonymous") + "|" + (r[idx.input_index] != null ? r[idx.input_index] : ""));
    }
  });

  if (!totalRows) {
    console.log("Found " + files.length + " file(s) but no usable rows in any of them.");
    return;
  }

  console.log("bake-tally: " + files.length + " file(s), " + totalRows + " ratings, " + raters.size + " rater(s): " + Array.from(raters).join(", "));
  console.log("");

  const systems = Object.keys(tally).sort();
  const colWidth = 14;
  function pad(s, w) { s = String(s); return s + " ".repeat(Math.max(0, w - s.length)); }

  const header = "system".padEnd(8) + ALL_TAGS.map(function (t) { return pad(t, colWidth); }).join("") + pad("net", 8) + "judgments";
  console.log(header);
  console.log("-".repeat(header.length));

  const scored = systems.map(function (s) {
    const counts = tally[s] || {};
    const positive = POSITIVE_TAGS.reduce(function (sum, t) { return sum + (counts[t] || 0); }, 0);
    const negative = NEGATIVE_TAGS.reduce(function (sum, t) { return sum + (counts[t] || 0); }, 0);
    return { system: s, counts: counts, net: positive - negative, judgments: (seenJudgments[s] || new Set()).size };
  });
  scored.sort(function (a, b) { return b.net - a.net; });

  scored.forEach(function (row) {
    const line = row.system.padEnd(8) +
      ALL_TAGS.map(function (t) { return pad(row.counts[t] || 0, colWidth); }).join("") +
      pad(row.net, 8) + row.judgments;
    console.log(line);
  });

  console.log("\n\"net\" = (funniest + most surprising + most tailored + most shareable) − (too random + too far). Read the full table, not just this column — a system winning on net while losing on \"too far\" tells a different story than one winning cleanly.");
}

main();
