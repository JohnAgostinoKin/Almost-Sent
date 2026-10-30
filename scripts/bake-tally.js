#!/usr/bin/env node
// scripts/bake-tally.js
//
// Reads every CSV scripts/bake-rate.html produced (one per rater — see
// its own header comment for why the file isn't a shared one), unblinds
// them (the `system` column was always there, just never shown to the
// rater — see bake-rate.html's renderRound), and prints one table per
// rubric and system: counts, screenshot rate and any failure reasons.
// Historical laughter ratings and impact-v1 ratings are kept separate.
// Impact tags overlap and are independent from strength or unwanted reactions.
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

const SCHEMAS = {
  "comedy-v4": ["lol", "smirk", "nothing", "bad"],
  "impact-v1": ["strong", "mild", "none"]
};
const REACTIONS = ["shock", "embarrassment", "disgust", "brutal", "laugh"];

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

// Separate rubric groups: old LOL ratings are never converted to impact.
function summarizeFiles(files) {
  const groups = {};
  files.forEach(function (file) {
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    if (!rows.length) return;
    const header = rows.shift().map(function (h) { return h.trim(); });
    for (const key of ["rater", "system", "rating"]) {
      if (!header.includes(key)) throw new Error(file + ": missing column " + key);
    }
    rows.forEach(function (fields, rowIndex) {
      const row = Object.fromEntries(header.map(function (key, i) { return [key, fields[i] || ""]; }));
      if (!row.system || !row.rating) return;
      const schema = row.schema || "comedy-v4";
      if (!SCHEMAS[schema] || !SCHEMAS[schema].includes(row.rating)) {
        throw new Error(file + ": row " + (rowIndex + 2) + " has invalid rating/schema " + row.rating + "/" + schema);
      }
      const reactions = Array.from(new Set((row.reactions || "").split("|").filter(Boolean)));
      if (reactions.some(function (r) { return !REACTIONS.includes(r); })) throw new Error(file + ": unknown reaction type");
      if (!groups[schema]) groups[schema] = {};
      if (!groups[schema][row.system]) groups[schema][row.system] = { total: 0, counts: {}, reactions: {}, failures: {}, screenshots: 0 };
      const summary = groups[schema][row.system];
      summary.total++;
      summary.counts[row.rating] = (summary.counts[row.rating] || 0) + 1;
      if (/^(yes|true|1)$/i.test(row.screenshot)) summary.screenshots++;
      reactions.forEach(function (r) { summary.reactions[r] = (summary.reactions[r] || 0) + 1; });
      if (row.failure) summary.failures[row.failure] = (summary.failures[row.failure] || 0) + 1;
    });
  });
  return groups;
}

function main() {
  const files = findCsvFiles(process.argv.slice(2));
  if (!files.length) throw new Error("No CSV files found. Pass downloaded rating CSV paths to bake-tally.");
  const groups = summarizeFiles(files);
  function pad(value, width) { return String(value).padEnd(width); }
  function pct(count, total) { return Math.round(100 * count / total) + "%"; }
  Object.keys(groups).sort().forEach(function (schema) {
    const ratings = SCHEMAS[schema];
    console.log("\n" + schema + (schema === "impact-v1" ? " — reaction strength; laughter optional" : " — historical laughter rubric"));
    console.log(pad("system", 14) + ratings.map(function (r) { return pad(r, 10); }).join("") + pad("shot%", 10) + "rated");
    Object.keys(groups[schema]).sort().forEach(function (system) {
      const row = groups[schema][system];
      console.log(pad(system, 14) + ratings.map(function (r) { return pad(row.counts[r] || 0, 10); }).join("") + pad(pct(row.screenshots, row.total), 10) + row.total);
      if (schema === "impact-v1") console.log("  reaction tags: " + REACTIONS.map(function (r) { return r + "=" + (row.reactions[r] || 0); }).join(", "));
      if (Object.keys(row.failures).length) console.log("  misses: " + Object.entries(row.failures).map(function (entry) { return entry[0] + "=" + entry[1]; }).join(", "));
    });
  });
  console.log("\nCounts and screenshot rates use rated rows only. Missing ratings are not failures. Reaction tags can overlap. Keep rubrics separate; a strong reaction can still be marked too far or not my taste. No launch threshold is inferred.");
}

module.exports = { parseCsv, summarizeFiles };
if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
