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
  active_energy: number;
  steps: number;
  distance: number;
  flights: number;
  resting_hr: number[];
  hrv: number[];
  resp_rate: number[];
  blood_o2: number[];
  hr_min: number[];
  hr_max: number[];
  wrist_temp: number[];
  exercise_min: number;
  stand_hr: number;
  weight: number[];
  body_fat: number[];
  lean_mass: number[];
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
    const val = (key: string): number | null => {
      const v = row[key];
      if (!v || v === "") return null;
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };

    const ae = val("Active Energy (kcal)"); if (ae) totals.active_energy += ae;
    const sc = val("Step Count (steps)"); if (sc) totals.steps += sc;
    const dist = val("Walking + Running Distance (mi)"); if (dist) totals.distance += dist;
    const fl = val("Flights Climbed (count)"); if (fl) totals.flights += fl;
    const rhr = val("Resting Heart Rate (bpm)"); if (rhr) totals.resting_hr.push(rhr);
    const hrv = val("Heart Rate Variability (ms)"); if (hrv) totals.hrv.push(hrv);
    const rr = val("Respiratory Rate (count/min)"); if (rr) totals.resp_rate.push(rr);
    const o2 = val("Blood Oxygen Saturation (%)"); if (o2) totals.blood_o2.push(o2);
    const hrMin = val("Heart Rate [Min] (bpm)"); if (hrMin) totals.hr_min.push(hrMin);
    const hrMax = val("Heart Rate [Max] (bpm)"); if (hrMax) totals.hr_max.push(hrMax);
    const wt = val("Apple Sleeping Wrist Temperature (ºF)"); if (wt) totals.wrist_temp.push(wt);
    const ex = val("Apple Exercise Time (min)"); if (ex) totals.exercise_min += ex;
    const sh = val("Apple Stand Hour (hr)"); if (sh) totals.stand_hr += sh;
    const w = val("Weight (lbs)"); if (w) totals.weight.push(w);
    const bf = val("Body Fat Percentage (%)"); if (bf) totals.body_fat.push(bf);
    const lm = val("Lean Body Mass (lbs)"); if (lm) totals.lean_mass.push(lm);

    for (const [csvKey, totalKey] of SLEEP_FIELDS) {
      const v = val(csvKey);
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
  active_cal: string | null;
  total_cal: string | null;
  avg_hr: string | null;
  max_hr: string | null;
  distance: string | null;
  avg_speed: string | null;
  steps: string | null;
  step_cadence: string | null;
  swim_strokes: string | null;
  swim_cadence: string | null;
  flights: string | null;
  elevation_ascended: string | null;
  elevation_descended: string | null;
}

function parseWorkouts(date: string): Workout[] {
  const path = join(WORKOUTS_DIR, `Workouts-${date}.csv`);
  if (!existsSync(path)) return [];

  const optStr = (val: string | undefined): string | null => val && val !== "" ? val : null;

  return parseCSV(readFileSync(path, "utf-8")).map(row => ({
    type: row["Type"] ?? "",
    start: row["Start"] ?? "",
    end: row["End"] ?? "",
    duration: row["Duration"] ?? "",
    active_cal: optStr(row["Active Energy (kcal)"]),
    total_cal: optStr(row["Total Energy (kcal)"]),
    avg_hr: optStr(row["Avg Heart Rate (bpm)"]),
    max_hr: optStr(row["Max Heart Rate (bpm)"]),
    distance: optStr(row["Distance (mi)"]),
    avg_speed: optStr(row["Avg Speed (mi/hr)"]),
    steps: optStr(row["Step Count (count)"]),
    step_cadence: optStr(row["Step Cadence (spm)"]),
    swim_strokes: optStr(row["Swimming Stroke Count (count)"]),
    swim_cadence: optStr(row["Swim Stoke Cadence (spm)"] ?? row["Swim Stroke Cadence (spm)"]),
    flights: optStr(row["Flights Climbed (count)"]),
    elevation_ascended: optStr(row["Elevation Ascended (ft)"]),
    elevation_descended: optStr(row["Elevation Descended (ft)"]),
  }));
}

function formatDailySummary(date: string, metrics: DailyMetrics, workouts: Workout[]) {
  return {
    date,
    body: {
      weight: avg(metrics.weight),
      body_fat_pct: avg(metrics.body_fat),
      lean_mass: avg(metrics.lean_mass),
    },
    activity: {
      steps: Math.round(metrics.steps),
      distance_mi: +metrics.distance.toFixed(1),
      flights: Math.round(metrics.flights),
      active_energy_kcal: Math.round(metrics.active_energy),
      exercise_min: Math.round(metrics.exercise_min),
      stand_hours: Math.round(metrics.stand_hr),
    },
    heart: (() => {
      const rhr = avg(metrics.resting_hr);
      const hrv = avg(metrics.hrv);
      const rr = avg(metrics.resp_rate);
      const o2 = avg(metrics.blood_o2);
      const wt = avg(metrics.wrist_temp);
      return {
        resting_hr: rhr ? Math.round(rhr) : null,
        hrv_ms: hrv ? Math.round(hrv) : null,
        resp_rate: rr ? +rr.toFixed(1) : null,
        spo2_pct: o2 ? Math.round(o2) : null,
        hr_min: metrics.hr_min.length ? Math.min(...metrics.hr_min) : null,
        hr_max: metrics.hr_max.length ? Math.max(...metrics.hr_max) : null,
        wrist_temp_f: wt ? +wt.toFixed(1) : null,
      };
    })(),
    sleep: {
      total: fmtDuration(metrics.sleep_total),
      asleep: fmtDuration(metrics.sleep_asleep),
      in_bed: fmtDuration(metrics.sleep_inbed),
      deep: fmtDuration(metrics.sleep_deep),
      rem: fmtDuration(metrics.sleep_rem),
      core: fmtDuration(metrics.sleep_core),
      awake: fmtDuration(metrics.sleep_awake),
    },
    workouts,
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
  return text({ date: d, count: workouts.length, workouts });
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
      results.push({
        date: d,
        steps: Math.round(metrics.steps),
        active_energy: Math.round(metrics.active_energy),
        resting_hr: rhr ? Math.round(rhr) : null,
        hrv: hrv ? Math.round(hrv) : null,
        sleep_total_hrs: +metrics.sleep_total.toFixed(1),
        weight: avg(metrics.weight),
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
