import fs from "node:fs";
import { Impit } from "impit";

// Playwright proxy dict. Matches the python service-tester format so a
// single proxies.txt is interchangeable between camoufox-py and camoufox-js.
export interface PlaywrightProxy {
	server: string;
	username?: string;
	password?: string;
}

export interface ProxyGeo {
	query?: string;
	city?: string;
	country?: string;
	timezone?: string;
}

export function loadProxies(filePath: string): PlaywrightProxy[] {
	if (!fs.existsSync(filePath)) {
		console.error(`ERROR: Proxies file not found: ${filePath}`);
		console.error(
			"  Create a proxies.txt file with one proxy per line: user:pass@domain:port",
		);
		process.exit(1);
	}

	const proxies: PlaywrightProxy[] = [];
	const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith("#")) continue;
		const atIdx = line.lastIndexOf("@");
		const credColon = line.indexOf(":");
		if (atIdx < 0 || credColon < 0 || credColon > atIdx) {
			console.error(
				`ERROR: proxies.txt line ${i + 1}: expected user:pass@domain:port, got: ${JSON.stringify(line)}`,
			);
			process.exit(1);
		}
		const creds = line.slice(0, atIdx);
		const hostport = line.slice(atIdx + 1);
		const [user, password] = [
			creds.slice(0, creds.indexOf(":")),
			creds.slice(creds.indexOf(":") + 1),
		];
		const portIdx = hostport.lastIndexOf(":");
		const domain = hostport.slice(0, portIdx);
		const port = hostport.slice(portIdx + 1);
		proxies.push({
			server: `http://${domain}:${port}`,
			username: user,
			password,
		});
	}

	if (proxies.length === 0) {
		console.error("ERROR: proxies.txt contains no valid proxy entries.");
		process.exit(1);
	}
	return proxies;
}

// Queries ip-api.com through the proxy for IP, city, country, timezone.
// Returns {} on any failure — the certificate display tolerates "?" values.
// Uses impit (already a runtime dep of camoufox-js) for proxy + timeout.
export async function resolveProxyGeo(proxy: PlaywrightProxy): Promise<ProxyGeo> {
	if (!proxy.server) return {};
	const u = new URL(proxy.server);
	const auth =
		proxy.username && proxy.password
			? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
			: "";
	const proxyUrl = `${u.protocol}//${auth}${u.host}`;

	try {
		const client = new Impit({ proxyUrl, timeout: 10_000 });
		const resp = await client.fetch(
			"http://ip-api.com/json?fields=query,city,country,timezone",
		);
		if (!resp.ok) return {};
		return ((await resp.json()) as ProxyGeo) ?? {};
	} catch {
		return {};
	}
}
