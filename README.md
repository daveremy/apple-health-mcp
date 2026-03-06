# apple-health-mcp

An MCP server for Apple Health data. Reads daily health metrics and workouts exported by the [Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567461) iOS app.

## Features

- **MCP Server**: 3 tools for querying Apple Health data from Claude Code or any MCP client
- **No API keys needed**: Reads local CSV files exported by Health Auto Export to iCloud Drive
- **Comprehensive**: Steps, HR, HRV, SpO2, sleep stages, body composition, workouts

## MCP Tools

| Tool | Description |
|------|-------------|
| `apple_health_daily` | Daily summary: steps, energy, HR, HRV, sleep stages, body comp, workouts |
| `apple_health_workouts` | Workout sessions for a date (type, duration, HR, calories, distance) |
| `apple_health_trends` | Multi-day trends for steps, HR, HRV, sleep, weight |

## Setup

### 1. Install Health Auto Export on iPhone

1. Install [Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567461) from the App Store
2. Configure it to export daily metrics and workouts as CSV to iCloud Drive
3. The default export path is: `~/Library/Mobile Documents/iCloud~com~ifunography~HealthExport/Documents/`

### 2. Install

```bash
git clone https://github.com/daveremy/apple-health-mcp.git
cd apple-health-mcp
npm install
npm run build
```

### 3. Use as MCP Server

Add to your Claude Code project's `.mcp.json`:

```json
{
  "mcpServers": {
    "apple-health": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/apple-health-mcp/dist/mcp.js"]
    }
  }
}
```

Or register with the Claude CLI:

```bash
claude mcp add apple-health --scope project -- node /path/to/apple-health-mcp/dist/mcp.js
```

### Custom Export Directory

If your Health Auto Export saves to a different location, set the environment variable:

```json
{
  "env": {
    "APPLE_HEALTH_EXPORT_DIR": "/path/to/your/export/directory"
  }
}
```

## Data Format

The server expects the CSV file structure produced by Health Auto Export:

```
Documents/
  Daily Export/
    HealthMetrics-YYYY-MM-DD.csv
  Workouts/
    Workouts-YYYY-MM-DD.csv
```

## Requirements

- Node.js 18+
- macOS (for iCloud Drive access)
- [Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567461) iOS app

## License

MIT
