import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import socket

WORKER_PATH = Path(__file__).parents[1] / "src" / "crawl4ai_worker.py"
SPEC = importlib.util.spec_from_file_location("crawl4ai_worker", WORKER_PATH)
WORKER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(WORKER)

import httpx

class SSRFDNSPinningAndRebindingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connection_count = 0

        async def handle_client(reader, writer):
            self.connection_count += 1
            data = await reader.read(100)
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        self.server = await asyncio.start_server(handle_client, '127.0.0.1', 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def test_ssrf_safe_transport_blocks_unauthorized_loopback_with_zero_connections(self):
        transport = WORKER.SSRFSafeTransport(allowed_destinations=[])
        client = httpx.AsyncClient(transport=transport)
        try:
            with self.assertRaises(Exception) as ctx:
                await client.get(f"http://127.0.0.1:{self.port}/secret")
            self.assertIn("SSRF blocked", str(ctx.exception))
            self.assertEqual(self.connection_count, 0, "Denied destination must record ZERO socket connections")
        finally:
            await client.aclose()

    async def test_ssrf_safe_transport_allows_explicitly_authorized_destination(self):
        transport = WORKER.SSRFSafeTransport(allowed_destinations=[f"127.0.0.1:{self.port}"])
        client = httpx.AsyncClient(transport=transport)
        try:
            resp = await client.get(f"http://127.0.0.1:{self.port}/allowed")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(self.connection_count, 1)
        finally:
            await client.aclose()

    async def test_dns_rebinding_rejection_before_tcp_connect(self):
        # Simulate DNS rebinding: host looks public initially, but resolves to 127.0.0.1 at connection time
        transport = WORKER.SSRFSafeTransport(allowed_destinations=[])
        client = httpx.AsyncClient(transport=transport)

        # Mock getaddrinfo at connect time to return loopback 127.0.0.1 for an apparently public host
        real_getaddrinfo = socket.getaddrinfo
        def fake_getaddrinfo(host, port, *args, **kwargs):
            if host == "rebound.example.com":
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', port))]
            return real_getaddrinfo(host, port, *args, **kwargs)

        try:
            with patch("socket.getaddrinfo", side_effect=fake_getaddrinfo):
                with self.assertRaises(Exception) as ctx:
                    await client.get(f"http://rebound.example.com:{self.port}/rebinding-attack")
                self.assertIn("SSRF blocked before connection", str(ctx.exception))
                self.assertEqual(self.connection_count, 0, "Rebound destination must record ZERO socket connections")
        finally:
            await client.aclose()

    async def test_concurrent_transports_maintain_independent_policy_isolation(self):
        transport_allowed = WORKER.SSRFSafeTransport(allowed_destinations=[f"127.0.0.1:{self.port}"])
        transport_denied = WORKER.SSRFSafeTransport(allowed_destinations=["93.184.216.34"])

        client_allowed = httpx.AsyncClient(transport=transport_allowed)
        client_denied = httpx.AsyncClient(transport=transport_denied)

        try:
            # Run concurrent requests
            req_allowed = client_allowed.get(f"http://127.0.0.1:{self.port}/concurrent-allowed")
            req_denied = client_denied.get(f"http://127.0.0.1:{self.port}/concurrent-denied")

            results = await asyncio.gather(req_allowed, req_denied, return_exceptions=True)

            self.assertEqual(results[0].status_code, 200)
            self.assertIsInstance(results[1], Exception)
            self.assertIn("SSRF blocked", str(results[1]))
            self.assertEqual(self.connection_count, 1, "Only authorized client connects; denied client records zero connections")
        finally:
            await client_allowed.aclose()
            await client_denied.aclose()

    async def test_redirect_to_loopback_records_zero_connections(self):
        """Verifies that an authorized endpoint redirecting to an unauthorized local endpoint connects 0 times to the target."""
        forbidden_hits = 0
        async def handle_forbidden(reader, writer):
            nonlocal forbidden_hits
            forbidden_hits += 1
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nSECRET")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        forbidden_srv = await asyncio.start_server(handle_forbidden, "127.0.0.1", 0)
        f_port = forbidden_srv.sockets[0].getsockname()[1]

        async def handle_redirect(reader, writer):
            await reader.read(200)
            writer.write(f"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{f_port}/secret\r\nContent-Length: 0\r\n\r\n".encode())
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        redir_srv = await asyncio.start_server(handle_redirect, "127.0.0.1", 0)
        r_port = redir_srv.sockets[0].getsockname()[1]

        client = WORKER.create_ssrf_safe_client(allowed_destinations=[f"http://127.0.0.1:{r_port}"])
        try:
            with self.assertRaises(Exception):
                await client.get(f"http://127.0.0.1:{r_port}/start")
            self.assertEqual(forbidden_hits, 0, "Redirect to denied target must record ZERO socket connections")
        finally:
            await client.aclose()
            forbidden_srv.close()
            await forbidden_srv.wait_closed()
            redir_srv.close()
            await redir_srv.wait_closed()

if __name__ == "__main__":
    unittest.main()
