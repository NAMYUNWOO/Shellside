// Certificates and the board browser.
//
// Chrome only says "net::ERR_CERT_AUTHORITY_INVALID". To say more, the server fetches the certificate the site presents
// and checks who issued it and who trusts that issuer. The common case is a network that inspects HTTPS: a proxy
// re-signs sites with the organization's own root CA, the operating system's store trusts it, and Linux Chrome doesn't,
// because it reads extra roots from its NSS database (~/.pki/nssdb), not from /etc/ssl/certs.
//
// WB_BROWSER_CA lists extra root CAs for the board browser only (Linux): Chrome runs with its own NSS database that
// holds exactly those, so nothing else of the person's trusts them. TLS is never weakened (no
// --ignore-certificate-errors), and the agent can't go past Chrome's warning page (see BrowserTool.act).
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import { connect as tlsConnect, rootCertificates } from "node:tls";
import { BoardError } from "./board.ts";

export const DOCS = 'poc/README.md, "Networks that inspect HTTPS"';
const DAY = 24 * 3600_000;

interface Known {
  cert: X509Certificate;
  /** Where it came from: a file, or a short description of a store. */
  source: string;
}

// ── reading certificates ─────────────────────────────────────────────────────
function readCerts(file: string): X509Certificate[] {
  const raw = readFileSync(file);
  const pems = raw.toString("latin1").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  const out: X509Certificate[] = [];
  if (pems) {
    for (const p of pems) {
      try {
        out.push(new X509Certificate(p));
      } catch {}
    }
    return out;
  }
  try {
    return [new X509Certificate(raw)]; // one DER certificate
  } catch {
    return [];
  }
}

/** Certificate files in a folder (one level, as update-ca-certificates and ca-trust read them) or the file itself. */
function certFiles(path: string): string[] {
  try {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true }).flatMap((d) => {
      const p = join(path, d.name);
      if (d.isDirectory()) return certFiles(p);
      return /\.(crt|pem|cer)$/i.test(d.name) ? [p] : [];
    });
  } catch {
    return [];
  }
}

const load = (files: string[], source?: string): Known[] => files.flatMap((f) => (existsSync(f) ? readCerts(f).map((cert) => ({ cert, source: source ?? f })) : []));

/** One name for a certificate's subject or issuer: its CN, else its O. */
function dnName(dn: string): string {
  const parts = new Map(dn.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const));
  return parts.get("CN") || parts.get("O") || parts.get("OU") || dn.replace(/\n/g, ", ");
}
const day = (s: string) => new Date(Date.parse(s)).toISOString().slice(0, 10);
const selfSigned = (c: X509Certificate) => c.checkIssued(c) && c.verify(c.publicKey);

/** The certificate in `store` that anchors this chain: one of its certificates, or the issuer of one. */
function anchor(chain: X509Certificate[], store: Known[]): Known | null {
  for (const c of chain) {
    for (const k of store) {
      if (k.cert.fingerprint256 === c.fingerprint256) return k;
      try {
        if (c.checkIssued(k.cert) && c.verify(k.cert.publicKey)) return k;
      } catch {}
    }
  }
  return null;
}

// ── stores ───────────────────────────────────────────────────────────────────
let publicCAs: Known[] | null = null;
/** The public root CAs Node ships (Mozilla's list, close to Chrome's own root store). */
const publicStore = () => (publicCAs ??= rootCertificates.map((p) => ({ cert: new X509Certificate(p), source: "public CAs" })));

/** Folders where a person or an organization adds root CAs on Linux (Debian/Ubuntu, Fedora/RHEL). */
const LOCAL_CA_DIRS = ["/usr/local/share/ca-certificates", "/etc/pki/ca-trust/source/anchors"];
/** The system's compiled bundle, which also holds the public CAs. */
const SYSTEM_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"];

/** Root CAs added on this computer, outside the public list: what an organization that inspects HTTPS installs. */
export function localCAs(env = process.env, os = platform()): Known[] {
  const out = os === "linux" ? LOCAL_CA_DIRS.flatMap((d) => load(certFiles(d))) : [];
  if (env.NODE_EXTRA_CA_CERTS) out.push(...load([env.NODE_EXTRA_CA_CERTS]).map((k) => ({ ...k, source: `${k.source} (NODE_EXTRA_CA_CERTS)` })));
  const pub = new Set(publicStore().map((k) => k.cert.fingerprint256));
  const seen = new Set<string>();
  return out.filter((k) => !pub.has(k.cert.fingerprint256) && !seen.has(k.cert.fingerprint256) && seen.add(k.cert.fingerprint256));
}

/** What this computer trusts besides the board browser: its local CAs first (they name a file), then its bundle. */
function systemStore(env = process.env, os = platform()): Known[] {
  const bundles = os === "linux" ? [env.SSL_CERT_FILE, ...SYSTEM_BUNDLES].filter((f): f is string => !!f) : [];
  return [...localCAs(env, os), ...load(bundles.filter(existsSync).slice(0, 1), "the system's certificate store")];
}

/** WB_BROWSER_CA: files or folders, separated like PATH. */
export function browserCaFiles(env = process.env): string[] {
  return (env.WB_BROWSER_CA ?? "")
    .split(delimiter)
    .map((s) => s.trim().replace(/^~(?=\/|$)/, homedir()))
    .filter(Boolean);
}
const browserExtraStore = (env = process.env): Known[] => browserCaFiles(env).flatMap((p) => load(certFiles(p)));

// ── the board browser's own NSS database (Linux) ─────────────────────────────
function certutil(args: string[]) {
  return execFileSync("certutil", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const hasCertutil = () => {
  try {
    certutil(["-H"]);
    return true;
  } catch (err: any) {
    return err?.code !== "ENOENT"; // -H exits non-zero but runs
  }
};

/**
 * The environment to start Chrome with. Without WB_BROWSER_CA: the server's own (Chrome reads the person's
 * ~/.pki/nssdb). With it: HOME is a folder of the server's whose .pki/nssdb holds exactly those CAs, rebuilt when the
 * list changes. The XDG folders and ~/.fonts keep pointing at the person's own, so fonts look the same.
 */
export function browserEnv(baseDir: string, env = process.env): NodeJS.ProcessEnv | undefined {
  const files = browserCaFiles(env);
  if (!files.length || platform() !== "linux") return undefined;
  const cas = browserExtraStore(env);
  if (!cas.length) throw new BoardError(`WB_BROWSER_CA is set to ${env.WB_BROWSER_CA}, but no certificate was found there. Point it at PEM files (.crt, .pem) or a folder of them, and restart the server.`, 503);
  const realHome = homedir();
  const home = join(baseDir, "home");
  const db = join(home, ".pki", "nssdb");
  const marker = join(db, "shellside-cas.txt");
  const want = cas.map((k) => k.cert.fingerprint256).sort().join("\n");
  const current = existsSync(join(db, "cert9.db")) && existsSync(marker) ? readFileSync(marker, "utf8") : null;
  if (current !== want) {
    if (!hasCertutil()) {
      throw new BoardError(
        'WB_BROWSER_CA needs certutil to give the board browser its own certificate database. Install it with "sudo apt install libnss3-tools" (or see ' + DOCS + "), then try again.",
        503,
      );
    }
    rmSync(db, { recursive: true, force: true });
    mkdirSync(db, { recursive: true, mode: 0o700 });
    certutil(["-N", "-d", `sql:${db}`, "--empty-password"]);
    for (const [i, k] of cas.entries()) {
      const tmp = join(db, `import-${i}.pem`);
      writeFileSync(tmp, k.cert.toString());
      try {
        // C,, = a trusted CA for TLS servers only (not e-mail or code signing).
        certutil(["-A", "-d", `sql:${db}`, "-n", `${dnName(k.cert.subject)} (${k.cert.fingerprint256.slice(0, 11)})`, "-t", "C,,", "-i", tmp]);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    writeFileSync(marker, want);
  }
  for (const name of [".fonts", ".fontconfig"]) {
    const link = join(home, name);
    if (existsSync(join(realHome, name)) && !lstatSafe(link)) symlinkSync(join(realHome, name), link);
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || join(realHome, ".config"),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME || join(realHome, ".cache"),
    XDG_DATA_HOME: env.XDG_DATA_HOME || join(realHome, ".local", "share"),
  };
}
const lstatSafe = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** Fingerprints of the CAs an NSS database trusts for TLS, or null when it can't be read (no certutil). */
function nssTrusted(db: string): Set<string> | null {
  if (!existsSync(join(db, "cert9.db"))) return new Set();
  if (!hasCertutil()) return null;
  try {
    const out = new Set<string>();
    for (const line of certutil(["-L", "-d", `sql:${db}`]).split("\n")) {
      const m = /^(.*\S)\s+([a-zA-Z]*),([a-zA-Z]*),([a-zA-Z]*)\s*$/.exec(line);
      if (!m || !/C/.test(m[2])) continue;
      for (const k of readPem(certutil(["-L", "-d", `sql:${db}`, "-n", m[1], "-a"]))) out.add(k.fingerprint256);
    }
    return out;
  } catch {
    return null;
  }
}
const readPem = (text: string) => (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => new X509Certificate(p));

// ── what the server says at start ────────────────────────────────────────────
/** Certificate setup worth knowing before a page fails: extra CAs in use, CAs the browser doesn't trust, expiry. */
export function startupNotes(env = process.env): string[] {
  const notes: string[] = [];
  const os = platform();
  const soon = (k: Known) => {
    const left = Date.parse(k.cert.validTo) - Date.now();
    return left < 0 ? `expired on ${day(k.cert.validTo)}` : left < 30 * DAY ? `expires on ${day(k.cert.validTo)}` : "";
  };
  if (browserCaFiles(env).length) {
    if (os !== "linux") {
      notes.push(`WB_BROWSER_CA works on Linux only. Here Chrome uses the system's certificate store${os === "darwin" ? " (the keychain)" : ""}, so add the CA there instead.`);
    } else {
      const extra = browserExtraStore(env);
      notes.push(
        extra.length
          ? `trusts these extra root CAs (WB_BROWSER_CA), and nothing else of yours does: ${extra.map((k) => `"${dnName(k.cert.subject)}"${soon(k) ? ` (${soon(k)})` : ""}`).join(", ")}`
          : `WB_BROWSER_CA is set to ${env.WB_BROWSER_CA}, but no certificate was found there.`,
      );
    }
    return notes;
  }
  if (os !== "linux") return notes;
  const local = localCAs(env, os);
  if (!local.length) return notes;
  const nss = nssTrusted(join(homedir(), ".pki", "nssdb"));
  const missing = nss ? local.filter((k) => !nss.has(k.cert.fingerprint256)) : local;
  if (missing.length) {
    const list = missing.map((k) => `"${dnName(k.cert.subject)}" (${k.source}${soon(k) ? `, ${soon(k)}` : ""})`).join(", ");
    const files = [...new Set(missing.map((k) => k.source.replace(/ \(NODE_EXTRA_CA_CERTS\)$/, "")))].join(delimiter);
    notes.push(
      `this computer trusts root CAs that ${nss ? "the board browser doesn't" : "the board browser may not (it reads ~/.pki/nssdb, not the system's store)"}: ${list}. ` +
        `If your network inspects HTTPS with them, sites will fail with a certificate error. To trust them in the board browser only, start the server with WB_BROWSER_CA=${files} (${DOCS}).`,
    );
  }
  return notes;
}

// ── explaining a certificate error ───────────────────────────────────────────
export const isCertError = (code: string) => /^net::ERR_CERT_/.test(code);

/** The proxy Chrome on Linux would use for this host (https_proxy, all_proxy; no_proxy), if any. */
function proxyFor(host: string, env = process.env): URL | null {
  const raw = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  if (!raw) return null;
  const skip = (env.no_proxy || env.NO_PROXY || "").split(/[\s,]+/).filter(Boolean);
  for (const s of skip) {
    const e = s.replace(/:\d+$/, "").replace(/^\*?\./, "");
    if (s === "*" || host === e || host.endsWith(`.${e}`)) return null;
  }
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return u.protocol === "http:" ? u : null; // https:// and socks proxies: connect directly instead
  } catch {
    return null;
  }
}

/** A TCP connection to host:port, through an HTTP proxy's CONNECT when one applies. */
function tunnel(host: string, port: number, ms: number): Promise<Socket> {
  const proxy = proxyFor(host);
  return new Promise((resolve, reject) => {
    const s = netConnect(proxy ? Number(proxy.port) || 80 : port, proxy ? proxy.hostname : host);
    s.setTimeout(ms, () => s.destroy(new Error(`no answer within ${ms / 1000} s`)));
    s.once("error", reject);
    if (!proxy) return s.once("connect", () => (s.setTimeout(0), resolve(s)));
    s.once("connect", () => {
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n` : "";
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let head = "";
    const onData = (d: Buffer) => {
      head += d.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return head.length > 16384 ? s.destroy(new Error("the proxy sent no answer")) : undefined;
      s.off("data", onData);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
      if (status !== "200") return s.destroy(new Error(`the proxy answered ${status ?? "something unexpected"}`));
      s.setTimeout(0);
      resolve(s);
    };
    s.on("data", onData);
  });
}

/** The certificates a site presents, leaf first. */
export async function fetchChain(host: string, port: number, ms = 5000): Promise<X509Certificate[]> {
  const raw = await tunnel(host, port, ms);
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ socket: raw, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => s.destroy(new Error(`no TLS answer within ${ms / 1000} s`)), ms);
    s.once("error", (e) => (clearTimeout(timer), reject(e)));
    s.once("secureConnect", () => {
      clearTimeout(timer);
      const chain: X509Certificate[] = [];
      const seen = new Set<string>();
      for (let c: any = s.getPeerCertificate(true); c?.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
        seen.add(c.fingerprint256);
        chain.push(new X509Certificate(c.raw));
      }
      s.destroy();
      chain.length ? resolve(chain) : reject(new Error("the site sent no certificate"));
    });
  });
}

const cache = new Map<string, { at: number; text: Promise<string> }>();

/** One or two sentences for the person (and the agent) on why Chrome refused this site's certificate. */
export function explainCertError(url: string, code: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve(`The site's certificate was refused (${code}).`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = Number(u.port) || 443;
  const key = `${host}:${port} ${code}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.text;
  const text = fetchChain(host, port)
    .then((chain) => describe(u.host, code, chain))
    .catch((err) => `Chrome refused the certificate of ${u.host} (${code}). The server couldn't fetch it to say more: ${(err as Error).message}.`);
  cache.set(key, { at: Date.now(), text });
  return text;
}

/** The explanation, from the chain the site presents. Exported for tests. */
export function describe(where: string, code: string, chain: X509Certificate[], env = process.env, os = platform()): string {
  const leaf = chain[0];
  const top = chain[chain.length - 1];
  const issuer = `"${dnName(leaf.issuer)}"`;
  const root = selfSigned(top) ? dnName(top.subject) : dnName(top.issuer);
  const via = root !== dnName(leaf.issuer) ? `, under the root "${root}"` : "";
  const fix =
    os === "linux"
      ? (file: string) => `To trust it in the board browser only, start the server with WB_BROWSER_CA=${file} (${DOCS}).`
      : (_file: string) => `Chrome here uses the system's certificate store, so the CA has to be added there (${DOCS}).`;

  if (code === "net::ERR_CERT_DATE_INVALID") {
    const now = Date.now();
    const old = chain.find((c) => Date.parse(c.validTo) < now);
    const early = chain.find((c) => Date.parse(c.validFrom) > now);
    const which = old ?? early ?? leaf;
    const what = which === leaf ? `The certificate of ${where}` : `The CA certificate "${dnName(which.subject)}" that ${where} presents`;
    return old
      ? `${what} expired on ${day(old.validTo)} (issued by "${dnName(which.issuer)}").`
      : early
        ? `${what} is valid only from ${day(early.validFrom)}. If the date on this computer is wrong, fix it.`
        : `Chrome says the certificate of ${where} is out of date (valid ${day(leaf.validFrom)} to ${day(leaf.validTo)}). Check the date on this computer.`;
  }
  if (code === "net::ERR_CERT_COMMON_NAME_INVALID") {
    const names = (leaf.subjectAltName ?? "").replace(/IP Address:/g, "").replace(/DNS:/g, "") || dnName(leaf.subject);
    return `The certificate ${where} presents is for ${names}, not for this address (issued by ${issuer}).`;
  }
  if (code !== "net::ERR_CERT_AUTHORITY_INVALID") return `Chrome refused the certificate of ${where} (${code}). It is issued by ${issuer}${via}.`;

  const extra = anchor(chain, browserExtraStore(env));
  if (extra) return `The certificate of ${where} is issued by ${issuer}${via}, which WB_BROWSER_CA lists, yet the board browser refused it. Check the server's log from when the browser started.`;
  if (anchor(chain, publicStore()))
    return `The certificate of ${where} is issued by ${issuer}${via}, a public CA, yet the board browser refused it. The site may send an incomplete chain, or Chrome reaches it through a different network path than the server.`;
  const sys = anchor(chain, systemStore(env, os));
  if (sys) {
    const file = sys.source.replace(/ \(NODE_EXTRA_CA_CERTS\)$/, "");
    return (
      `The certificate of ${where} is issued by ${issuer}${via}. This computer trusts that CA (${sys.source}), but the board browser doesn't: your network probably inspects HTTPS and re-signs sites with it. ` +
      fix(existsSync(file) ? file : "<the CA's .crt file>")
    );
  }
  return (
    `The certificate of ${where} is issued by ${issuer}${via}, which neither the board browser nor this computer trusts. ` +
    `If your network inspects HTTPS, get its root CA from your IT team (${DOCS}). Otherwise someone may be intercepting the connection: don't continue.`
  );
}

/** Added to what the agent sees: whose job this is. */
export const AGENT_CERT_NOTE =
  "This is the person's network setup or the site's certificate, not something to retry or work around, and Claude can't go past Chrome's certificate warning: tell the person what this says.";
