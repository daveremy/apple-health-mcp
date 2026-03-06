# Contributing

Thanks for your interest in contributing!

## Getting Started

1. Fork the repo
2. Clone your fork: `git clone https://github.com/your-username/apple-health-mcp.git`
3. Install dependencies: `npm install`
4. Build: `npm run build`

## Development

- `npm run dev` — run MCP server via tsx (no build needed)
- `npm run build` — compile TypeScript
- Source is in `src/`, output goes to `dist/`

## Pull Requests

- Keep changes focused — one feature or fix per PR
- Test with real Health Auto Export CSV files before submitting
- If adding new metrics, follow the existing pattern in the `parseMetrics` function

## Issues

Bug reports and feature requests are welcome. Please include:
- What you expected vs. what happened
- Node.js version and macOS version
- Sample CSV structure (with personal data removed) if relevant
