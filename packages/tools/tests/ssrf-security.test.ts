import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  isIpAddressForbidden,
  validateWebDestination,
  validateWebDestinationAsync,
} from "../src/index.ts";

test("SSRF Security: comprehensive IP address classification", () => {
  // IPv4 Loopback & Special
  assert.equal(isIpAddressForbidden("127.0.0.1").forbidden, true, "127.0.0.1 must be forbidden");
  assert.equal(isIpAddressForbidden("127.0.0.2").forbidden, true, "127.0.0.2 must be forbidden");
  assert.equal(isIpAddressForbidden("127.255.255.254").forbidden, true, "127.255.255.254 must be forbidden");
  assert.equal(isIpAddressForbidden("0.0.0.0").forbidden, true, "0.0.0.0 must be forbidden");

  // Cloud Metadata & Link-Local
  assert.equal(isIpAddressForbidden("169.254.169.254").forbidden, true, "169.254.169.254 metadata must be forbidden");
  assert.equal(isIpAddressForbidden("169.254.1.1").forbidden, true, "169.254.0.0/16 must be forbidden");

  // Private RFC1918
  assert.equal(isIpAddressForbidden("10.0.0.1").forbidden, true, "10.0.0.0/8 must be forbidden");
  assert.equal(isIpAddressForbidden("172.16.0.1").forbidden, true, "172.16.0.0/12 must be forbidden");
  assert.equal(isIpAddressForbidden("172.31.255.255").forbidden, true, "172.31.255.255 must be forbidden");
  assert.equal(isIpAddressForbidden("192.168.1.1").forbidden, true, "192.168.0.0/16 must be forbidden");

  // Carrier-grade NAT & Reserved
  assert.equal(isIpAddressForbidden("100.64.0.1").forbidden, true, "100.64.0.0/10 CGNAT must be forbidden");
  assert.equal(isIpAddressForbidden("192.0.2.1").forbidden, true, "TEST-NET-1 must be forbidden");
  assert.equal(isIpAddressForbidden("198.51.100.1").forbidden, true, "TEST-NET-2 must be forbidden");
  assert.equal(isIpAddressForbidden("203.0.113.1").forbidden, true, "TEST-NET-3 must be forbidden");
  assert.equal(isIpAddressForbidden("224.0.0.1").forbidden, true, "Multicast must be forbidden");
  assert.equal(isIpAddressForbidden("240.0.0.1").forbidden, true, "Reserved 240.0.0.0/4 must be forbidden");

  // IPv6
  assert.equal(isIpAddressForbidden("::1").forbidden, true, "::1 loopback must be forbidden");
  assert.equal(isIpAddressForbidden("::").forbidden, true, ":: unspecified must be forbidden");
  assert.equal(isIpAddressForbidden("fc00::1").forbidden, true, "fc00::/7 ULA must be forbidden");
  assert.equal(isIpAddressForbidden("fd12:3456::1").forbidden, true, "fd00::/8 ULA must be forbidden");
  assert.equal(isIpAddressForbidden("fe80::1").forbidden, true, "fe80::/10 link-local must be forbidden");
  assert.equal(isIpAddressForbidden("ff02::1").forbidden, true, "ff00::/8 multicast must be forbidden");

  // IPv4-mapped IPv6
  assert.equal(isIpAddressForbidden("::ffff:127.0.0.1").forbidden, true, "::ffff:127.0.0.1 mapped loopback must be forbidden");
  assert.equal(isIpAddressForbidden("::ffff:169.254.169.254").forbidden, true, "::ffff:169.254.169.254 mapped metadata must be forbidden");
  assert.equal(isIpAddressForbidden("::ffff:10.0.0.1").forbidden, true, "::ffff:10.0.0.1 mapped private must be forbidden");

  // Public valid IPs
  assert.equal(isIpAddressForbidden("8.8.8.8").forbidden, false, "8.8.8.8 public must be allowed");
  assert.equal(isIpAddressForbidden("1.1.1.1").forbidden, false, "1.1.1.1 public must be allowed");
  assert.equal(isIpAddressForbidden("2606:4700:4700::1111").forbidden, false, "Cloudflare public IPv6 must be allowed");
});

test("SSRF Security: validateWebDestination and validateWebDestinationAsync enforce boundary before network", async () => {
  // Forbidden protocols
  assert.throws(() => validateWebDestination("file:///etc/passwd"), /Forbidden protocol/);
  assert.throws(() => validateWebDestination("ftp://example.com/test"), /Forbidden protocol/);
  assert.throws(() => validateWebDestination("javascript:alert(1)"), /Forbidden protocol/);

  // Cloud metadata strictly blocked
  assert.throws(() => validateWebDestination("http://169.254.169.254/latest/meta-data"), /Access to private metadata service/);
  assert.throws(() => validateWebDestination("http://metadata.google.internal/computeMetadata/v1/"), /Access to private metadata service/);
  assert.throws(() => validateWebDestination("http://instance-data/latest/meta-data"), /Access to private metadata service/);

  // Unscoped localhost and private IPs blocked
  assert.throws(() => validateWebDestination("http://127.0.0.1:8080/"), /forbidden/i);
  assert.throws(() => validateWebDestination("http://127.0.0.2:8080/"), /forbidden/i);
  assert.throws(() => validateWebDestination("http://[::1]:8080/"), /forbidden/i);
  assert.throws(() => validateWebDestination("http://[::ffff:127.0.0.1]:8080/"), /forbidden/i);
  assert.throws(() => validateWebDestination("http://10.0.0.5:8080/"), /forbidden/i);
  assert.throws(() => validateWebDestination("http://192.168.1.1:8080/"), /forbidden/i);

  // DNS-based loopback resolution blocked asynchronously
  await assert.rejects(
    () => validateWebDestinationAsync("http://localhost:8080/"),
    /forbidden/i,
  );

  // Narrowly scoped authorization permits only the exact authorized origin
  const scopedUrl = validateWebDestination("http://127.0.0.1:8991/docs/flip-card", {
    allowedDestinations: ["http://127.0.0.1:8991"],
  });
  assert.equal(scopedUrl.href, "http://127.0.0.1:8991/docs/flip-card");

  // Scoped authorization NEVER permits metadata even if requested
  assert.throws(
    () =>
      validateWebDestination("http://169.254.169.254/secret", {
        allowedDestinations: ["http://169.254.169.254"],
      }),
    /Access to private metadata service/,
  );

  // Different port on localhost remains blocked
  assert.throws(
    () =>
      validateWebDestination("http://127.0.0.1:9999/unauthorized", {
        allowedDestinations: ["http://127.0.0.1:8991"],
      }),
    /forbidden/i,
  );
});

test("SSRF Security: denied targets receive zero connections", async () => {
  let connectionCount = 0;
  const server = http.createServer((req, res) => {
    connectionCount++;
    res.writeHead(200);
    res.end("ok");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const targetUrl = `http://127.0.0.1:${port}/sensitive-data`;

  try {
    // Attempt validation without scoped permission
    await assert.rejects(
      async () => {
        await validateWebDestinationAsync(targetUrl);
      },
      /forbidden/i,
    );

    // Verify server received ZERO connections
    assert.equal(connectionCount, 0, "Denied destination must receive ZERO network connections");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
