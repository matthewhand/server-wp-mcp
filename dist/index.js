#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import fs from 'fs/promises';
import https from 'https'; // Import Node.js https module for TLS config
// Load site config from config file or environment variables
export async function loadSiteConfig() {
    // Handle semicolon-delimited values with escape support
    const parseEnvArray = (envVar) => {
        if (!envVar)
            return [];
        // Replace escaped semicolons with Unicode placeholder
        return envVar.replace(/\\;/g, '\uE000')
            .split(';')
            .map(s => s.replace(/\uE000/g, ';').trim())
            .filter(Boolean);
    };
    const names = parseEnvArray(process.env.WP_NAME);
    const urls = parseEnvArray(process.env.WP_URL_OVERRIDE);
    const users = parseEnvArray(process.env.WP_USER_OVERRIDE);
    const passes = parseEnvArray(process.env.WP_PASS_OVERRIDE);
    if (names.length + urls.length + users.length + passes.length > 0) {
        if (names.length !== urls.length || urls.length !== users.length || users.length !== passes.length) {
            throw new Error(`All environment variables must have matching number of values. Found:
- Sites: ${names.length}
- URLs: ${urls.length}
- Users: ${users.length}
- Passwords: ${passes.length}`);
        }
        console.log(`Using ${names.length} site configurations from environment variables`);
        return Object.fromEntries(names.map((name, i) => [
            name.toLowerCase().trim(),
            {
                url: urls[i].replace(/\/$/, '').trim(),
                username: users[i].trim(),
                auth: passes[i].trim()
            }
        ]));
    }
    // Fall back to file-based configuration
    const configPath = process.env.WP_SITES_PATH;
    if (!configPath) {
        throw new Error("WP_SITES_PATH environment variable is required when not using environment overrides");
    }
    try {
        const configData = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(configData);
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
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Config file not found at: ${configPath}`);
        }
        throw new Error(`Failed to load config: ${error.message}`);
    }
}
// WordPress client class
class WordPressClient {
    client;
    constructor(site) {
        const allowInsecureTls = process.env.WP_ALLOW_INSECURE_TLS === 'true'; // Check env var
        const config = {
            baseURL: `${site.url}/wp-json`,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };
        // Add HTTPS agent to ignore TLS errors if enabled
        if (allowInsecureTls) {
            config.httpsAgent = new https.Agent({
                rejectUnauthorized: false // Equivalent to curl -k
            });
            console.warn(`Warning: Allowing insecure TLS connections for ${site.url}`);
        }
        if (site.auth) {
            const credentials = `${site.username}:${site.auth.replace(/\s+/g, '')}`;
            if (config.headers) {
                config.headers['Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
            }
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
        if (method === 'GET' && params)
            config.params = params;
        else if (params)
            config.data = params;
        console.log(`Making request to: ${this.client.defaults.baseURL + path} with method: ${method} and params:`, params);
        try {
            const response = await this.client.request(config);
            return response.data;
        }
        catch (error) {
            console.error(`Request failed:`, error);
            console.error(`Error message:`, error.message);
            console.error(`Response data:`, error.response?.data);
            throw error;
        }
    }
}
// Start the server
async function main() {
    try {
        const siteConfig = await loadSiteConfig();
        const clients = new Map();
        for (const [alias, site] of Object.entries(siteConfig)) {
            clients.set(alias, new WordPressClient(site));
        }
        const server = new Server({
            name: "server-wp-mcp",
            version: "1.0.0"
        }, {
            capabilities: { tools: {} }
        });
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
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args = {} } = request.params;
            switch (name) {
                case "wp_discover_endpoints": {
                    if (typeof args.site !== 'string') {
                        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid 'site' argument for wp_discover_endpoints");
                    }
                    const client = clients.get(args.site.toLowerCase());
                    if (!client)
                        throw new McpError(ErrorCode.InvalidParams, `Unknown site: ${args.site}`);
                    const endpoints = await client.discoverEndpoints();
                    return { content: [{ type: "text", text: JSON.stringify(endpoints, null, 2) }] };
                }
                case "wp_call_endpoint": {
                    if (typeof args.site !== 'string' || typeof args.endpoint !== 'string') {
                        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid 'site' or 'endpoint' argument for wp_call_endpoint");
                    }
                    const client = clients.get(args.site.toLowerCase());
                    if (!client)
                        throw new McpError(ErrorCode.InvalidParams, `Unknown site: ${args.site}`);
                    const result = await client.makeRequest(args.endpoint, args.method, args.params);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            }
        });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error(`WordPress MCP server started with ${clients.size} site(s) configured`);
    }
    catch (error) {
        console.error(`Server failed to start: ${error.message}`);
        process.exit(1);
    }
}
// Only run main if not in test environment and when executed directly
// Handle CLI arguments
const debugMode = process.argv.includes('--debug');
if (debugMode) {
    process.env.DEBUG = '*';
    process.env.NODE_DEBUG = 'mcp*';
}
main();
