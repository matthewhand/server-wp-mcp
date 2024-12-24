#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import fs from 'fs/promises';

// Load site config from config file
async function loadSiteConfig() {
	const configPath = process.env.WP_SITES_PATH;
	if (!configPath) {
		throw new Error("WP_SITES_PATH environment variable is required");
	}

	try {
		const configData = await fs.readFile(configPath, 'utf8');
		const config = JSON.parse(configData);
		
		// Validate and normalize the config
		const normalizedConfig = {};
		for (const [alias, site] of Object.entries(config)) {
			if (!site.URL || !site.USER || !site.PASS) {
				console.error(`Invalid configuration for site ${alias}: missing required fields`);
				continue;
			}

			normalizedConfig[alias.toLowerCase()] = {
				url: site.URL.replace(/\/$/, ''),
				username: site.USER,
				auth: site.PASS
			};
		}

		return normalizedConfig;
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new Error(`Config file not found at: ${configPath}`);
		}
		throw new Error(`Failed to load config: ${error.message}`);
	}
}

// WordPress client class
class WordPressClient {
	constructor(site) {
		const config = {
			baseURL: `${site.url}/wp-json`,
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			}
		};

		if (site.auth) {
			const credentials = `${site.username}:${site.auth.replace(/\s+/g, '')}`;
			config.headers['Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
		}

		this.client = axios.create(config);
	}

	async discoverEndpoints() {
		const response = await this.client.get('/');
		const routes = response.data?.routes ?? {};
		return Object.entries(routes).map(([path, info]) => ({
			methods: info.methods ?? [],
			namespace: info.namespace ?? 'wp/v2',
			endpoints: [path]
		}));
	}

	async makeRequest(endpoint, method = 'GET', params) {
		const path = endpoint.replace(/^\/wp-json/, '').replace(/^\/?/, '/');
		const config = { method, url: path };
		
		if (method === 'GET' && params) {
			config.params = params;
		} else if (params) {
			config.data = params;
		}

		const response = await this.client.request(config);
		return response.data;
	}
}

// Start the server
async function main() {
	try {
		// Load configuration
		const siteConfig = await loadSiteConfig();
		const clients = new Map();

		for (const [alias, site] of Object.entries(siteConfig)) {
			clients.set(alias, new WordPressClient(site));
		}

		// Initialize server
		const server = new Server({
			name: "server-wp-mcp",
			version: "1.0.0"
		}, {
			capabilities: { tools: {} }
		});

		// Tool definitions
		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [{
				name: "wp_discover_endpoints",
				description: "The discovery operation maps all available REST API endpoints on a WordPress site and returns their methods and namespaces. This allows you to understand what operations are possible on a target WordPress site without having to manually specify endpoints, which is important because different WordPress websites can have many different and varying endpoints.",
				inputSchema: {
					type: "object",
					properties: {
						site: { type: "string", description: "Site alias" }
					},
					required: ["site"]
				}
			}, {
				name: "wp_call_endpoint",
				description: "The call operation executes specific REST API requests to the target WordPress sites using provided parameters and authentication. It handles both read and write operations. It determines which endpoint to use after the discovery operation is conducted.",
				inputSchema: {
					type: "object",
					properties: {
						site: { type: "string" },
						endpoint: { type: "string" },
						method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
						params: { type: "object" }
					},
					required: ["site", "endpoint"]
				}
			}]
		}));

		// Tool handlers
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params;

			switch (name) {
				case "wp_discover_endpoints": {
					const client = clients.get(args.site.toLowerCase());
					if (!client) throw new McpError(ErrorCode.InvalidParams, `Unknown site: ${args.site}`);
					const endpoints = await client.discoverEndpoints();
					return { content: [{ type: "text", text: JSON.stringify(endpoints, null, 2) }] };
				}
				case "wp_call_endpoint": {
					const client = clients.get(args.site.toLowerCase());
					if (!client) throw new McpError(ErrorCode.InvalidParams, `Unknown site: ${args.site}`);
					const result = await client.makeRequest(args.endpoint, args.method, args.params);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				}
				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		});

		// Start server
		const transport = new StdioServerTransport();
		await server.connect(transport);
		
		console.error(`WordPress MCP server started with ${clients.size} site(s) configured`);
	} catch (error) {
		console.error(`Server failed to start: ${error.message}`);
		process.exit(1);
	}
}

main();