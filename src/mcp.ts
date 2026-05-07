#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "./version.js";

const BASE = process.env.APPLE_HEALTH_EXPORT_DIR ??
  join(homedir(), "Library/Mobile Documents/iCloud~com~ifunography~HealthExport/Documents");
const METRICS_DIR = join(BASE, "Daily Export");
const WORKOUTS_DIR = join(BASE, "Workouts");

// Output unit system. Default = imperial (preserves existing field names).
// Set UNITS=metric to emit kg/km/kJ/°C/m and renamed fields like weight_kg.
// The parser auto-detects whichever unit the CSV uses for each column, so
// HealthAutoExport's metric or imperial export both work regardless of UNITS.
type UnitSystem = "metric" | "imperial";
const UNITS: UnitSystem = (process.env.UNITS === "metric" ? "metric" : "imperial");

// Conversions to canonical (imperial) storage.
const KJ_PER_KCAL = 4.184;
const KM_PER_MI = 1.609344;
const KG_PER_LB = 0.45359237;
const M_PER_FT = 0.3048;
const cToF = (c: number) => c * 1.8 + 32;
const fToC = (f: number) => (f - 32) / 1.8;

const server = new McpServer({ name: "apple-health", version: VERSION });

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function avg(arr: number[]): number | null {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function fmtDuration(hours: number): string {
  if (!hours) return "0m";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

interface DailyMetrics {
  active_energy: number;     // kcal
  steps: number;
  distance: number;          // mi
  flights: number;
  resting_hr: number[];      // bpm
  hrv: number[];             // ms
  resp_rate: number[];       // /min
  blood_o2: number[];        // %
  hr_min: number[];          // bpm
  hr_max: number[];          // bpm
  wrist_temp: number[];      // °F
  exercise_min: number;
  stand_hr: number;
  weight: number[];          // lbs
  body_fat: number[];        // %
  lean_mass: number[];       // lbs
  sleep_total: number;
  sleep_asleep: number;
  sleep_deep: number;
  sleep_rem: number;
  sleep_core: number;
  sleep_awake: number;
  sleep_inbed: number;
}

function parseCSV(content: string): Array<Record<string, string>> {
  const lines = content.split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.split(",");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

const SLEEP_FIELDS: Array<[string, keyof DailyMetrics]> = [
  ["Sleep Analysis [Total] (hr)", "sleep_total"],
  ["Sleep Analysis [Asleep] (hr)", "sleep_asleep"],
  ["Sleep Analysis [In Bed] (hr)", "sleep_inbed"],
  ["Sleep Analysis [Deep] (hr)", "sleep_deep"],
  ["Sleep Analysis [REM] (hr)", "sleep_rem"],
  ["Sleep Analysis [Core] (hr)", "sleep_core"],
  ["Sleep Analysis [Awake] (hr)", "sleep_awake"],
];

// Read whichever variant of a column exists. Returns the numeric value plus
// a tag identifying which variant matched, so callers can convert units.
function valVariant<T extends string>(
  row: Record<string, string>,
  variants: Array<[T, string]>,
): { tag: T; value: number } | null {
  for (const [tag, key] of variants) {
    const v = row[key];
    if (!v || v === "") continue;
    const n = parseFloat(v);
    if (!isNaN(n)) return { tag, value: n };
  }
  return null;
}

function val(row: Record<string, string>, key: string): number | null {
  const v = row[key];
  if (!v || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseMetrics(date: string): DailyMetrics | null {
  const path = join(METRICS_DIR, `HealthMetrics-${date}.csv`);
  if (!existsSync(path)) return null;

  const totals: DailyMetrics = {
    active_energy: 0, steps: 0, distance: 0, flights: 0,
    resting_hr: [], hrv: [], resp_rate: [], blood_o2: [],
    hr_min: [], hr_max: [], wrist_temp: [],
    exercise_min: 0, stand_hr: 0,
    weight: [], body_fat: [], lean_mass: [],
    sleep_total: 0, sleep_asleep: 0, sleep_deep: 0,
    sleep_rem: 0, sleep_core: 0, sleep_awake: 0, sleep_inbed: 0,
  };

  const rows = parseCSV(readFileSync(path, "utf-8"));

  for (const row of rows) {
    // Active Energy: imperial=kcal, metric=kJ. Canonical=kcal.
    const ae = valVariant(row, [["kcal", "Active Energy (kcal)"], ["kJ", "Active Energy (kJ)"]]);
    if (ae) totals.active_energy += ae.tag === "kJ" ? ae.value / KJ_PER_KCAL : ae.value;

    // Steps: column unit is just a label (count or steps), value is identical.
    const sc = valVariant(row, [["count", "Step Count (count)"], ["steps", "Step Count (steps)"]]);
    if (sc) totals.steps += sc.value;

    // Walking + Running Distance: imperial=mi, metric=km. Canonical=mi.
    const dist = valVariant(row, [["mi", "Walking + Running Distance (mi)"], ["km", "Walking + Running Distance (km)"]]);
    if (dist) totals.distance += dist.tag === "km" ? dist.value / KM_PER_MI : dist.value;

    const fl = val(row, "Flights Climbed (count)");
    if (fl) totals.flights += fl;

    // Heart rate columns: bpm and count/min are equivalent labels.
    const rhr = valVariant(row, [["bpm", "Resting Heart Rate (bpm)"], ["cpm", "Resting Heart Rate (count/min)"]]);
    if (rhr) totals.resting_hr.push(rhr.value);

    const hrv = val(row, "Heart Rate Variability (ms)");
    if (hrv) totals.hrv.push(hrv);

    const rr = valVariant(row, [["cpm", "Respiratory Rate (count/min)"], ["bpm", "Respiratory Rate (bpm)"]]);
    if (rr) totals.resp_rate.push(rr.value);

    const o2 = val(row, "Blood Oxygen Saturation (%)");
    if (o2) totals.blood_o2.push(o2);

    const hrMin = valVariant(row, [["bpm", "Heart Rate [Min] (bpm)"], ["cpm", "Heart Rate [Min] (count/min)"]]);
    if (hrMin) totals.hr_min.push(hrMin.value);

    const hrMax = valVariant(row, [["bpm", "Heart Rate [Max] (bpm)"], ["cpm", "Heart Rate [Max] (count/min)"]]);
    if (hrMax) totals.hr_max.push(hrMax.value);

    // Wrist temp: imperial=°F (HealthAutoExport writes "ºF" with U+00BA), metric=degC. Canonical=°F.
    const wt = valVariant(row, [
      ["F", "Apple Sleeping Wrist Temperature (ºF)"],
      ["F", "Apple Sleeping Wrist Temperature (°F)"],
      ["C", "Apple Sleeping Wrist Temperature (degC)"],
    ]);
    if (wt) totals.wrist_temp.push(wt.tag === "C" ? cToF(wt.value) : wt.value);

    const ex = val(row, "Apple Exercise Time (min)");
    if (ex) totals.exercise_min += ex;

    // Stand Hour column unit is "hr" or "count" depending on export; both = hours stood.
    const sh = valVariant(row, [["hr", "Apple Stand Hour (hr)"], ["count", "Apple Stand Hour (count)"]]);
    if (sh) totals.stand_hr += sh.value;

    // Weight: imperial=lbs, metric=kg. Canonical=lbs.
    const w = valVariant(row, [["lbs", "Weight (lbs)"], ["kg", "Weight (kg)"]]);
    if (w) totals.weight.push(w.tag === "kg" ? w.value / KG_PER_LB : w.value);

    const bf = val(row, "Body Fat Percentage (%)");
    if (bf) totals.body_fat.push(bf);

    const lm = valVariant(row, [["lbs", "Lean Body Mass (lbs)"], ["kg", "Lean Body Mass (kg)"]]);
    if (lm) totals.lean_mass.push(lm.tag === "kg" ? lm.value / KG_PER_LB : lm.value);

    for (const [csvKey, totalKey] of SLEEP_FIELDS) {
      const v = val(row, csvKey);
      if (v && v > (totals[totalKey] as number)) {
        (totals[totalKey] as number) = v;
      }
    }
  }

  return totals;
}

interface Workout {
  type: string;
  start: string;
  end: string;
  duration: string;
  // Energy in kcal (canonical); rendered as kcal or kJ at output time.
  active_energy_kcal: number | null;
  total_energy_kcal: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  distance_mi: number | null;            // canonical mi
  avg_speed_mph: number | null;          // canonical mi/hr
  steps: number | null;
  step_cadence: number | null;
  swim_strokes: number | null;
  swim_cadence: number | null;
  flights: number | null;
  elevation_ascended_ft: number | null;  // canonical ft
  elevation_descended_ft: number | null;
}

function parseWorkouts(date: string): Workout[] {
  const path = join(WORKOUTS_DIR, `Workouts-${date}.csv`);
  if (!existsSync(path)) return [];

  return parseCSV(readFileSync(path, "utf-8")).map(row => {
    const ae = valVariant(row, [["kcal", "Active Energy (kcal)"], ["kJ", "Active Energy (kJ)"]]);
    const te = valVariant(row, [["kcal", "Total Energy (kcal)"], ["kJ", "Total Energy (kJ)"]]);
    const dist = valVariant(row, [["mi", "Distance (mi)"], ["km", "Distance (km)"]]);
    const sp = valVariant(row, [["mph", "Avg Speed (mi/hr)"], ["kmh", "Avg Speed (km/hr)"]]);
    const elA = valVariant(row, [["ft", "Elevation Ascended (ft)"], ["m", "Elevation Ascended (m)"]]);
    const elD = valVariant(row, [["ft", "Elevation Descended (ft)"], ["m", "Elevation Descended (m)"]]);

    return {
      type: row["Type"] ?? "",
      start: row["Start"] ?? "",
      end: row["End"] ?? "",
      duration: row["Duration"] ?? "",
      active_energy_kcal: ae ? (ae.tag === "kJ" ? ae.value / KJ_PER_KCAL : ae.value) : null,
      total_energy_kcal: te ? (te.tag === "kJ" ? te.value / KJ_PER_KCAL : te.value) : null,
      avg_hr: val(row, "Avg Heart Rate (bpm)") ?? val(row, "Avg Heart Rate (count/min)"),
      max_hr: val(row, "Max Heart Rate (bpm)") ?? val(row, "Max Heart Rate (count/min)"),
      distance_mi: dist ? (dist.tag === "km" ? dist.value / KM_PER_MI : dist.value) : null,
      avg_speed_mph: sp ? (sp.tag === "kmh" ? sp.value / KM_PER_MI : sp.value) : null,
      steps: val(row, "Step Count (count)") ?? val(row, "Step Count (steps)"),
      step_cadence: val(row, "Step Cadence (spm)"),
      swim_strokes: val(row, "Swimming Stroke Count (count)"),
      swim_cadence: val(row, "Swim Stoke Cadence (spm)") ?? val(row, "Swim Stroke Cadence (spm)"),
      flights: val(row, "Flights Climbed (count)"),
      elevation_ascended_ft: elA ? (elA.tag === "m" ? elA.value / M_PER_FT : elA.value) : null,
      elevation_descended_ft: elD ? (elD.tag === "m" ? elD.value / M_PER_FT : elD.value) : null,
    };
  });
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function renderWorkout(w: Workout): Record<string, unknown> {
  const optStr = (n: number | null, decimals = 2): string | null =>
    n === null ? null : (Math.round(n * 10 ** decimals) / 10 ** decimals).toString();

  const base: Record<string, unknown> = {
    type: w.type,
    start: w.start,
    end: w.end,
    duration: w.duration,
    avg_hr: optStr(w.avg_hr, 0),
    max_hr: optStr(w.max_hr, 0),
    steps: optStr(w.steps, 0),
    step_cadence: optStr(w.step_cadence, 2),
    swim_strokes: optStr(w.swim_strokes, 0),
    swim_cadence: optStr(w.swim_cadence, 2),
    flights: optStr(w.flights, 1),
  };
  if (UNITS === "metric") {
    return {
      ...base,
      active_energy_kj: optStr(w.active_energy_kcal !== null ? w.active_energy_kcal * KJ_PER_KCAL : null, 0),
      total_energy_kj: optStr(w.total_energy_kcal !== null ? w.total_energy_kcal * KJ_PER_KCAL : null, 0),
      distance_km: optStr(w.distance_mi !== null ? w.distance_mi * KM_PER_MI : null, 2),
      avg_speed_kmh: optStr(w.avg_speed_mph !== null ? w.avg_speed_mph * KM_PER_MI : null, 2),
      elevation_ascended_m: optStr(w.elevation_ascended_ft !== null ? w.elevation_ascended_ft * M_PER_FT : null, 1),
      elevation_descended_m: optStr(w.elevation_descended_ft !== null ? w.elevation_descended_ft * M_PER_FT : null, 1),
    };
  }
  // Imperial — preserves the historical field names from earlier releases.
  return {
    ...base,
    active_cal: optStr(w.active_energy_kcal, 0),
    total_cal: optStr(w.total_energy_kcal, 0),
    distance: optStr(w.distance_mi, 2),
    avg_speed: optStr(w.avg_speed_mph, 2),
    elevation_ascended: optStr(w.elevation_ascended_ft, 1),
    elevation_descended: optStr(w.elevation_descended_ft, 1),
  };
}

function formatDailySummary(date: string, metrics: DailyMetrics, workouts: Workout[]) {
  const rhr = avg(metrics.resting_hr);
  const hrv = avg(metrics.hrv);
  const rr = avg(metrics.resp_rate);
  const o2 = avg(metrics.blood_o2);
  const wt = avg(metrics.wrist_temp);
  const weight = avg(metrics.weight);
  const leanMass = avg(metrics.lean_mass);

  const heart = {
    resting_hr: rhr ? Math.round(rhr) : null,
    hrv_ms: hrv ? Math.round(hrv) : null,
    resp_rate: rr ? round1(rr) : null,
    spo2_pct: o2 ? Math.round(o2) : null,
    hr_min: metrics.hr_min.length ? Math.min(...metrics.hr_min) : null,
    hr_max: metrics.hr_max.length ? Math.max(...metrics.hr_max) : null,
    ...(UNITS === "metric"
      ? { wrist_temp_c: wt ? round2(fToC(wt)) : null }
      : { wrist_temp_f: wt ? round1(wt) : null }),
  };

  const body = UNITS === "metric"
    ? {
        weight_kg: weight === null ? null : round2(weight * KG_PER_LB),
        body_fat_pct: avg(metrics.body_fat),
        lean_mass_kg: leanMass === null ? null : round2(leanMass * KG_PER_LB),
      }
    : {
        weight: weight,
        body_fat_pct: avg(metrics.body_fat),
        lean_mass: leanMass,
      };

  const activity = UNITS === "metric"
    ? {
        steps: Math.round(metrics.steps),
        distance_km: round2(metrics.distance * KM_PER_MI),
        flights: Math.round(metrics.flights),
        active_energy_kj: Math.round(metrics.active_energy * KJ_PER_KCAL),
        exercise_min: Math.round(metrics.exercise_min),
        stand_hours: Math.round(metrics.stand_hr),
      }
    : {
        steps: Math.round(metrics.steps),
        distance_mi: round1(metrics.distance),
        flights: Math.round(metrics.flights),
        active_energy_kcal: Math.round(metrics.active_energy),
        exercise_min: Math.round(metrics.exercise_min),
        stand_hours: Math.round(metrics.stand_hr),
      };

  return {
    date,
    body,
    activity,
    heart,
    sleep: {
      total: fmtDuration(metrics.sleep_total),
      asleep: fmtDuration(metrics.sleep_asleep),
      in_bed: fmtDuration(metrics.sleep_inbed),
      deep: fmtDuration(metrics.sleep_deep),
      rem: fmtDuration(metrics.sleep_rem),
      core: fmtDuration(metrics.sleep_core),
      awake: fmtDuration(metrics.sleep_awake),
    },
    workouts: workouts.map(renderWorkout),
  };
}

const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, defaults to today");

server.registerTool("apple_health_daily", {
  title: "Daily Summary",
  description: "Get Apple Health daily summary: steps, energy, HR, HRV, sleep stages, body comp, workouts",
  inputSchema: z.object({ date: optDate }),
}, async ({ date }) => {
  const d = date ?? today();
  const metrics = parseMetrics(d);
  if (!metrics) return text({ error: `No health data found for ${d}`, path: METRICS_DIR });
  const workouts = parseWorkouts(d);
  return text(formatDailySummary(d, metrics, workouts));
});

server.registerTool("apple_health_workouts", {
  title: "Workouts",
  description: "Get workout sessions for a date",
  inputSchema: z.object({ date: optDate }),
}, async ({ date }) => {
  const d = date ?? today();
  const workouts = parseWorkouts(d);
  return text({ date: d, count: workouts.length, workouts: workouts.map(renderWorkout) });
});

server.registerTool("apple_health_trends", {
  title: "Multi-day Trends",
  description: "Get daily health metrics for a date range (steps, HR, HRV, sleep, weight)",
  inputSchema: z.object({
    days: z.number().optional().describe("Number of days to look back (default 7)"),
  }),
}, async ({ days }) => {
  const n = days ?? 7;
  const results: Array<Record<string, unknown>> = [];

  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const d = dt.toISOString().split("T")[0];
    const metrics = parseMetrics(d);
    if (metrics) {
      const rhr = avg(metrics.resting_hr);
      const hrv = avg(metrics.hrv);
      const weight = avg(metrics.weight);
      results.push({
        date: d,
        steps: Math.round(metrics.steps),
        ...(UNITS === "metric"
          ? { active_energy_kj: Math.round(metrics.active_energy * KJ_PER_KCAL) }
          : { active_energy: Math.round(metrics.active_energy) }),
        resting_hr: rhr ? Math.round(rhr) : null,
        hrv: hrv ? Math.round(hrv) : null,
        sleep_total_hrs: round1(metrics.sleep_total),
        ...(UNITS === "metric"
          ? { weight_kg: weight === null ? null : round2(weight * KG_PER_LB) }
          : { weight: weight }),
      });
    }
  }

  return text(results);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Apple Health MCP server error:", err);
  process.exit(1);
});
