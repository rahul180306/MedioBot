#!/usr/bin/env python3
"""
MedioBot V2 — Phase 5: Supervised Crawl4AI Worker Protocol
Communicates with MedioBot TypeScript runtime via stdin/stdout JSON-Lines.
Includes process-tree memory telemetry, lazy browser lifecycle, and lightweight HTTP extraction.
"""

import sys
import json
import asyncio
import hashlib
import time
import re
import os
import subprocess
import gc
import socket
import ipaddress
from urllib.parse import urlsplit, urlparse
from typing import Any, Dict, List, Optional

# Prompt injection signatures to detect in untrusted web content
PROMPT_INJECTION_PATTERNS = [
    re.compile(r"(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions", re.IGNORECASE),
    re.compile(r"system\s+(?:override|prompt|instructions)\s*:", re.IGNORECASE),
    re.compile(r"you\s+(?:are|must\s+now\s+act\s+as|are\s+no\s+longer)\s+(?:a\s+new|an\s+unrestricted|an\s+ai)", re.IGNORECASE),
    re.compile(r"drop\s+all\s+security\s+restrictions", re.IGNORECASE),
    re.compile(r"<\|im_start\|>", re.IGNORECASE),
    re.compile(r"<\s*system\s*>", re.IGNORECASE),
    re.compile(r"do\s+not\s+follow\s+your\s+developer", re.IGNORECASE),
]

def sanitize_and_check_injection(content: str) -> tuple[str, List[str]]:
    flags = []
    for pattern in PROMPT_INJECTION_PATTERNS:
        if pattern.search(content):
            flags.append(pattern.pattern)
    
    # Sanitize dangerous control tokens
    sanitized = content
    for pattern in PROMPT_INJECTION_PATTERNS:
        sanitized = pattern.sub("[REDACTED_POTENTIAL_PROMPT_INJECTION]", sanitized)
    
    return sanitized, flags

def compute_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()

SEARCH_STOPWORDS = {
    "about", "and", "any", "api", "are", "can", "check", "cite", "docs", "documentation", "for", "from",
    "how", "official", "one", "pass", "passed", "provide", "returns", "should", "state", "support",
    "the", "this", "what", "whether", "with", "url", "urls",
}

def meaningful_search_tokens(query: str) -> List[str]:
    return [token for token in re.split(r"\W+", query.lower()) if len(token) > 1 and token not in SEARCH_STOPWORDS]

def curated_match_score(query_tokens: List[str], item: Dict[str, Any]) -> int:
    text = f"{item['title']} {item['snippet']} {' '.join(item['tags'])}".lower()
    return sum(1 for token in query_tokens if token in text)

def get_process_tree_memory() -> Dict[str, Any]:
    """
    Measures current RSS for this worker process + all child processes (Chromium, Playwright helper).
    """
    pid = os.getpid()
    try:
        out = subprocess.check_output(['ps', '-eo', 'pid,ppid,rss']).decode('utf-8')
        lines = out.strip().split('\n')[1:]
        parent_map: Dict[int, List[int]] = {}
        rss_map: Dict[int, int] = {}
        for line in lines:
            parts = line.split()
            if len(parts) >= 3:
                p, pp, r = int(parts[0]), int(parts[1]), int(parts[2])
                parent_map.setdefault(pp, []).append(p)
                rss_map[p] = r * 1024  # ps rss in KB -> bytes
        
        pids = [pid]
        idx = 0
        while idx < len(pids):
            curr = pids[idx]
            idx += 1
            pids.extend(parent_map.get(curr, []))
        
        total_rss = sum(rss_map.get(p, 0) for p in pids)
        worker_rss = rss_map.get(pid, 0)
        child_count = max(0, len(pids) - 1)
        return {
            "workerRssBytes": worker_rss,
            "totalProcessTreeRssBytes": total_rss,
            "childProcessCount": child_count,
            "pids": pids,
        }
    except Exception as e:
        return {
            "workerRssBytes": 0,
            "totalProcessTreeRssBytes": 0,
            "childProcessCount": 0,
            "pids": [pid],
            "error": str(e),
        }


def is_ip_forbidden(ip_obj) -> tuple[bool, str]:
    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
        ip_obj = ip_obj.ipv4_mapped
    if ip_obj.is_loopback:
        return True, f"Loopback address ({ip_obj}) is forbidden"
    if ip_obj.is_private:
        return True, f"Private address space ({ip_obj}) is forbidden"
    if ip_obj.is_link_local:
        return True, f"Link-local address ({ip_obj}) is forbidden"
    if ip_obj.is_multicast:
        return True, f"Multicast address ({ip_obj}) is forbidden"
    if ip_obj.is_reserved:
        return True, f"Reserved address ({ip_obj}) is forbidden"
    if ip_obj.is_unspecified:
        return True, f"Unspecified address ({ip_obj}) is forbidden"
    if isinstance(ip_obj, ipaddress.IPv4Address):
        octets = [int(p) for p in ip_obj.exploded.split(".")]
        a, b = octets[0], octets[1]
        if a == 127:
            return True, f"Loopback range (127.0.0.0/8) is forbidden"
        if a == 0:
            return True, f"Current network (0.0.0.0/8) is forbidden"
        if a == 10:
            return True, f"Private range (10.0.0.0/8) is forbidden"
        if a == 169 and b == 254:
            return True, f"Link-local / cloud metadata (169.254.0.0/16) is strictly forbidden"
        if a == 172 and 16 <= b <= 31:
            return True, f"Private range (172.16.0.0/12) is forbidden"
        if a == 192 and b == 168:
            return True, f"Private range (192.168.0.0/16) is forbidden"
        if a == 100 and 64 <= b <= 127:
            return True, f"Shared address space / CGNAT (100.64.0.0/10) is forbidden"
    return False, ""

def is_forbidden_target(target_url: str, allowed_destinations: Optional[List[str]] = None) -> tuple[bool, str]:
    try:
        parsed = urlsplit(target_url)
        if parsed.scheme not in ("http", "https"):
            return True, f"Forbidden scheme '{parsed.scheme}'; only http and https are permitted"
        raw_host = (parsed.hostname or "").lower().strip("[]")
        if not raw_host:
            return True, "Missing host in target URL"
        if raw_host == "169.254.169.254" or "169.254.169.254" in raw_host or "metadata.google.internal" in raw_host or raw_host.endswith(".internal") or raw_host.endswith(".local") or "a9fe:a9fe" in raw_host or raw_host == "instance-data":
            return True, f"Access to cloud metadata / internal service '{raw_host}' is strictly forbidden"

        if allowed_destinations:
            origin = f"{parsed.scheme}://{parsed.netloc}"
            for allowed in allowed_destinations:
                if not allowed:
                    continue
                allowed_clean = allowed.strip()
                if target_url == allowed_clean or origin == allowed_clean or target_url.startswith(allowed_clean if allowed_clean.endswith("/") else allowed_clean + "/"):
                    return False, ""

        try:
            ip_obj = ipaddress.ip_address(raw_host)
            forbidden, reason = is_ip_forbidden(ip_obj)
            if forbidden:
                return True, reason
            return False, ""
        except ValueError:
            pass

        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            addrinfo = socket.getaddrinfo(raw_host, port, proto=socket.IPPROTO_TCP)
        except Exception as e:
            return True, f"DNS resolution failed for '{raw_host}': {e}"
        if not addrinfo:
            return True, f"DNS resolution returned no addresses for '{raw_host}'"

        for entry in addrinfo:
            resolved_ip_str = entry[4][0]
            try:
                resolved_ip = ipaddress.ip_address(resolved_ip_str)
                forbidden, reason = is_ip_forbidden(resolved_ip)
                if forbidden:
                    return True, f"Destination '{raw_host}' resolves to forbidden IP '{resolved_ip_str}' ({reason})"
            except ValueError:
                return True, f"Invalid resolved IP '{resolved_ip_str}' for '{raw_host}'"

        return False, ""
    except Exception as e:
        return True, f"SSRF destination validation error: {e}"


import socket
import ipaddress
import httpcore
import httpx
from httpcore._backends.anyio import AnyIOBackend

class SSRFSafeBackend(AnyIOBackend):
    def __init__(self, allowed_destinations=None):
        super().__init__()
        self.allowed_destinations = allowed_destinations or []

    async def connect_tcp(self, host: str, port: int, timeout: float = None, local_address: str = None, socket_options = None):
        # 1. Resolve host to IP(s)
        resolved_ips = []
        clean_host = host.strip("[]")
        try:
            addrinfo = socket.getaddrinfo(clean_host, port, proto=socket.IPPROTO_TCP)
            for family, type_, proto, canonname, sockaddr in addrinfo:
                ip = sockaddr[0]
                if ip not in resolved_ips:
                    resolved_ips.append(ip)
        except Exception as e:
            raise ValueError(f"SSRF blocked: DNS resolution failed for {host}: {e}")

        if not resolved_ips:
            raise ValueError(f"SSRF blocked: No DNS records found for {host}")

        # 2. Check each resolved IP against loopback, private, link-local, and reserved ranges
        for ip_str in resolved_ips:
            ip_obj = ipaddress.ip_address(ip_str)
            if ip_obj.is_loopback or ip_obj.is_private or ip_obj.is_link_local or ip_obj.is_reserved:
                allowed = False
                for a in self.allowed_destinations:
                    if not a:
                        continue
                    clean_a = str(a).strip()
                    if clean_a.startswith("http://") or clean_a.startswith("https://"):
                        try:
                            p = urlsplit(clean_a)
                            p_host = (p.hostname or "").lower()
                            p_port = p.port or (443 if p.scheme == "https" else 80)
                            if (host.lower() == p_host or ip_str == p_host) and (port == p_port):
                                allowed = True
                                break
                        except Exception:
                            pass
                    if clean_a in (host, ip_str, f"{host}:{port}", f"{ip_str}:{port}"):
                        allowed = True
                        break
                if not allowed:
                    raise ValueError(f"SSRF blocked before connection: forbidden IP {ip_str} for host {host}")

        # 3. Bind TCP connection directly to the first validated IP
        pinned_ip = resolved_ips[0]
        stream = await super().connect_tcp(
            host=pinned_ip,
            port=port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options
        )
        return stream

class SSRFSafeTransport(httpx.AsyncHTTPTransport):
    def __init__(self, allowed_destinations=None, **kwargs):
        super().__init__(**kwargs)
        self._pool = httpcore.AsyncConnectionPool(
            network_backend=SSRFSafeBackend(allowed_destinations=allowed_destinations),
            ssl_context=self._pool._ssl_context,
            max_connections=self._pool._max_connections,
            max_keepalive_connections=self._pool._max_keepalive_connections,
            keepalive_expiry=self._pool._keepalive_expiry,
        )

def create_ssrf_safe_client(allowed_destinations=None, timeout=15.0):
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MedioBot/2.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    transport = SSRFSafeTransport(allowed_destinations=allowed_destinations)
    return httpx.AsyncClient(transport=transport, timeout=timeout, follow_redirects=True, headers=headers)

class Crawl4AiWorker:
    def __init__(self, idle_timeout: float = 60.0):
        self.idle_timeout = idle_timeout
        self.crawler = None
        self.last_active = time.time()
        self._closing = False
        self._markdown_generator = None
        self._write_lock = asyncio.Lock()
        self._crawler_init_lock = asyncio.Lock()
        self._active_tasks = set()
        self._active_requests: Dict[str, asyncio.Task] = {}

    def get_markdown_generator(self):
        if self._markdown_generator is None:
            try:
                from crawl4ai import DefaultMarkdownGenerator
                self._markdown_generator = DefaultMarkdownGenerator()
            except Exception:
                self._markdown_generator = None
            return self._markdown_generator

    async def ensure_crawler(self):
        if self.crawler is None:
            async with self._crawler_init_lock:
                if self.crawler is None:
                    try:
                        from crawl4ai import AsyncWebCrawler
                        from crawl4ai.async_configs import BrowserConfig
                        browser_cfg = BrowserConfig(
                            headless=True,
                            verbose=False,
                            extra_args=["--disable-service-workers"],
                        )
                        self.crawler = AsyncWebCrawler(config=browser_cfg)
                        await self.crawler.start()

                        # Register on_page_context_created hook once during initialization.
                        # It pulls per-crawl allowed_destinations and pinned_client from config
                        # so concurrent crawls do not overwrite each other's policy.
                        async def on_page_context_created(page, config=None, **kwargs):
                            allowed_dests = getattr(config, "ssrf_allowed_destinations", None)
                            pinned_client = getattr(config, "ssrf_pinned_client", None)

                            # Block service worker access in page scripts
                            try:
                                await page.add_init_script("Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined });")
                            except Exception:
                                pass

                            async def route_filter(route):
                                req_url = route.request.url
                                if req_url.startswith(("data:", "blob:", "about:", "chrome:", "javascript:")):
                                    await route.continue_()
                                    return
                                f_sub, r_sub = is_forbidden_target(req_url, allowed_dests)
                                if f_sub:
                                    sys.stderr.write(f"SSRF blocked subresource: {req_url} ({r_sub})\n")
                                    sys.stderr.flush()
                                    await route.abort("blockedbyclient")
                                    return

                                if pinned_client is not None:
                                    try:
                                        hdrs = {k: v for k, v in route.request.headers.items() if k.lower() != "host"}
                                        body = route.request.post_data_buffer
                                        resp = await pinned_client.request(
                                            method=route.request.method,
                                            url=req_url,
                                            headers=hdrs,
                                            content=body,
                                        )
                                        resp_headers = dict(resp.headers)
                                        resp_headers.pop("content-encoding", None)
                                        resp_headers.pop("content-length", None)
                                        resp_headers.pop("transfer-encoding", None)
                                        resp_headers.pop("connection", None)
                                        await route.fulfill(
                                            status=resp.status_code,
                                            headers=resp_headers,
                                            body=resp.content,
                                        )
                                    except Exception as exc:
                                        sys.stderr.write(f"SSRF pinned route fulfillment blocked: {req_url} ({exc})\n")
                                        sys.stderr.flush()
                                        await route.abort("blockedbyclient")
                                else:
                                    sys.stderr.write(f"SSRF blocked: missing pinned context for route {req_url}\n")
                                    sys.stderr.flush()
                                    await route.abort("blockedbyclient")

                            await page.route("**/*", route_filter)
                            return page

                        self.crawler.crawler_strategy.set_hook("on_page_context_created", on_page_context_created)
                    except Exception as e:
                        sys.stderr.write(f"Failed to initialize Crawl4AI AsyncWebCrawler: {e}\n")
                        sys.stderr.flush()
                        raise

    async def release_browser(self):
        if self.crawler:
            try:
                await self.crawler.close()
            except Exception:
                pass
            self.crawler = None
            gc.collect()

    async def initialize(self):
        # We start lazily without launching Chromium until needed
        pass

    async def handle_crawl_http(self, url: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Lightweight HTTP extraction path using httpx and Crawl4AI DefaultMarkdownGenerator.
        Used when JavaScript rendering is not requested to save memory and avoid Chromium overhead.
        """
        import httpx
        from bs4 import BeautifulSoup

        start_time = time.time()
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 MedioBot/2.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }

        allowed_destinations = params.get("allowedDestinations")
        forbidden, reason = is_forbidden_target(url, allowed_destinations)
        if forbidden:
            raise ValueError(f"SSRF blocked before connection: {reason}")

        async def check_request(request: httpx.Request):
            target = str(request.url)
            f_req, r_req = is_forbidden_target(target, allowed_destinations)
            if f_req:
                raise ValueError(f"SSRF blocked before connection: {r_req}")

        async with create_ssrf_safe_client(allowed_destinations=allowed_destinations, timeout=15.0) as client:
            resp = await client.get(url)
            if resp.status_code >= 400:
                return None  # Let full crawler try or report status
            
            html = resp.text
            # If the response looks like an empty client-side SPA bundle and browser is permitted, fall back to browser
            allow_browser = params.get("allowBrowser", True)
            is_empty_spa = ('<div id="root"></div>' in html or '<div id="app"></div>' in html) and '<script' in html and len(html.strip()) < 1000
            if is_empty_spa and allow_browser:
                return None  # Fall back to full JS execution only if browser is allowed

            soup = BeautifulSoup(html, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""

            # Extract markdown via Crawl4AI DefaultMarkdownGenerator
            gen = self.get_markdown_generator()
            if gen:
                md_res = gen.generate_markdown(html)
                raw_markdown = getattr(md_res, "raw_markdown", "") or ""
            else:
                raw_markdown = soup.get_text(separator="\n\n", strip=True)

            sanitized_markdown, injection_flags = sanitize_and_check_injection(raw_markdown)

            # Extract links safely
            links = []
            for a in soup.find_all("a", href=True)[:100]:
                href = a["href"]
                text = a.get_text(strip=True)
                if href and not href.startswith("javascript:"):
                    links.append({"text": text, "href": href})

            # Extract media safely
            media = []
            for img in soup.find_all("img", src=True)[:50]:
                src = img["src"]
                alt = img.get("alt", "")
                if src:
                    media.append({"type": "image", "src": src, "alt": alt})

            duration_ms = int((time.time() - start_time) * 1000)
            provenance = {
                "sourceUrl": str(resp.url),
                "accessedAt": int(time.time() * 1000),
                "contentHash": compute_hash(sanitized_markdown),
                "documentedVersion": params.get("documentedVersion"),
            }

            return {
                "url": url,
                "finalUrl": str(resp.url),
                "status": resp.status_code,
                "success": True,
                "markdown": sanitized_markdown,
                "cleanedHtml": None,
                "title": title,
                "links": links,
                "media": media,
                "metadata": {"title": title, "extractionBackend": "crawl4ai-http-lightweight"},
                "cached": False,
                "sanitized": len(injection_flags) > 0,
                "provenance": provenance,
                "promptInjectionFlags": injection_flags,
                "durationMs": duration_ms,
                "errorMessage": None,
            }

    async def handle_crawl(self, params: Dict[str, Any]) -> Dict[str, Any]:
        url = params.get("url", "")
        if not url:
            raise ValueError("URL parameter is required")

        start_time = time.time()
        prefer_http = params.get("preferHttp", False)
        render_js = params.get("renderJs")
        allow_browser = params.get("allowBrowser", True)

        # 0. Handle raw: HTML content in memory without browser or network
        if url.startswith("raw:"):
            from bs4 import BeautifulSoup
            html = url[4:]
            soup = BeautifulSoup(html, "html.parser")
            title = soup.title.string.strip() if soup.title and soup.title.string else ""
            gen = self.get_markdown_generator()
            if gen:
                md_res = gen.generate_markdown(html)
                raw_markdown = getattr(md_res, "raw_markdown", "") or ""
            else:
                raw_markdown = soup.get_text(separator="\n\n", strip=True)

            sanitized_markdown, injection_flags = sanitize_and_check_injection(raw_markdown)
            links = []
            for a in soup.find_all("a", href=True)[:100]:
                href = a["href"]
                text = a.get_text(strip=True)
                if href and not href.startswith("javascript:"):
                    links.append({"text": text, "href": href})
            media = []
            for img in soup.find_all("img", src=True)[:50]:
                src = img["src"]
                alt = img.get("alt", "")
                if src:
                    media.append({"type": "image", "src": src, "alt": alt})

            duration_ms = int((time.time() - start_time) * 1000)
            provenance = {
                "sourceUrl": url,
                "accessedAt": int(time.time() * 1000),
                "contentHash": compute_hash(sanitized_markdown),
                "documentedVersion": params.get("documentedVersion"),
            }
            return {
                "url": url,
                "finalUrl": url,
                "status": 200,
                "success": True,
                "markdown": sanitized_markdown,
                "cleanedHtml": html if params.get("includeCleanedHtml") else None,
                "title": title,
                "links": links,
                "media": media,
                "metadata": {"title": title, "extractionBackend": "crawl4ai-raw-memory"},
                "cached": False,
                "sanitized": len(injection_flags) > 0,
                "provenance": provenance,
                "promptInjectionFlags": injection_flags,
                "durationMs": duration_ms,
                "errorMessage": None,
            }

        # SSRF Pre-flight check before HTTP or Chromium
        allowed_destinations = params.get("allowedDestinations")
        is_web_url = url.startswith("http://") or url.startswith("https://")
        if is_web_url:
            forbidden, reason = is_forbidden_target(url, allowed_destinations)
            if forbidden:
                return {
                    "url": url,
                    "finalUrl": url,
                    "status": 403,
                    "success": False,
                    "markdown": "",
                    "cleanedHtml": None,
                    "title": None,
                    "links": [],
                    "media": [],
                    "metadata": {"extractionBackend": "crawl4ai-ssrf-guard", "browserAdmitted": False},
                    "cached": False,
                    "sanitized": False,
                    "provenance": {"sourceUrl": url, "accessedAt": int(time.time() * 1000), "contentHash": ""},
                    "promptInjectionFlags": [],
                    "durationMs": int((time.time() - start_time) * 1000),
                    "errorMessage": f"SSRF blocked: {reason}",
                }

        # 1. Try lightweight HTTP extraction if JS is not strictly required or browser is not allowed
        is_web_url = url.startswith("http://") or url.startswith("https://")
        if is_web_url and (prefer_http or render_js is False or not allow_browser) and not params.get("waitForSelector"):
            try:
                http_result = await self.handle_crawl_http(url, params)
                if http_result is not None:
                    return http_result
            except ValueError as ve:
                if "SSRF blocked" in str(ve):
                    return {
                        "url": url,
                        "finalUrl": url,
                        "status": 403,
                        "success": False,
                        "markdown": "",
                        "cleanedHtml": None,
                        "title": None,
                        "links": [],
                        "media": [],
                        "metadata": {"extractionBackend": "crawl4ai-ssrf-guard", "browserAdmitted": False},
                        "cached": False,
                        "sanitized": False,
                        "provenance": {"sourceUrl": url, "accessedAt": int(time.time() * 1000), "contentHash": ""},
                        "promptInjectionFlags": [],
                        "durationMs": int((time.time() - start_time) * 1000),
                        "errorMessage": str(ve),
                    }
                pass
            except Exception:
                if not allow_browser:
                    return {
                        "url": url,
                        "finalUrl": url,
                        "status": 500,
                        "success": False,
                        "markdown": "",
                        "cleanedHtml": None,
                        "title": None,
                        "links": [],
                        "media": [],
                        "metadata": {"extractionBackend": "crawl4ai-http-lightweight", "browserAdmitted": False},
                        "cached": False,
                        "sanitized": False,
                        "provenance": {"sourceUrl": url, "accessedAt": int(time.time() * 1000), "contentHash": ""},
                        "promptInjectionFlags": [],
                        "durationMs": int((time.time() - start_time) * 1000),
                        "errorMessage": "HTTP crawl failed and browser session was not admitted",
                    }
                pass  # Fall through to browser crawler only if allowed

        if not allow_browser:
            return {
                "url": url,
                "finalUrl": url,
                "status": 403,
                "success": False,
                "markdown": "",
                "cleanedHtml": None,
                "title": None,
                "links": [],
                "media": [],
                "metadata": {"extractionBackend": "crawl4ai-http-lightweight", "browserAdmitted": False},
                "cached": False,
                "sanitized": False,
                "provenance": {"sourceUrl": url, "accessedAt": int(time.time() * 1000), "contentHash": ""},
                "promptInjectionFlags": [],
                "durationMs": int((time.time() - start_time) * 1000),
                "errorMessage": "Browser session not admitted; refusing to launch Chromium",
            }

        # 2. Browser-rendered extraction with Crawl4AI AsyncWebCrawler
        await self.ensure_crawler()

        # Instantiate per-crawl SSRF-safe pinned client for route fulfillment
        pinned_client = create_ssrf_safe_client(allowed_destinations=allowed_destinations, timeout=15.0)

        try:
            from crawl4ai.async_configs import CrawlerRunConfig, CacheMode

            cache_mode_str = params.get("cacheMode", "enabled")
            if cache_mode_str == "bypass":
                cache_mode = CacheMode.BYPASS
            elif cache_mode_str == "read-only":
                cache_mode = CacheMode.READ_ONLY
            else:
                cache_mode = CacheMode.ENABLED

            extract_opts = params.get("extractOptions", {})
            css_selector = extract_opts.get("cssSelector")
            wait_for = params.get("waitForSelector")

            run_cfg = CrawlerRunConfig(
                cache_mode=cache_mode,
                css_selector=css_selector,
                wait_for=wait_for,
                verbose=False,
            )
            run_cfg.ssrf_allowed_destinations = allowed_destinations
            run_cfg.ssrf_pinned_client = pinned_client

            result = await self.crawler.arun(url=url, config=run_cfg)
        finally:
            await pinned_client.aclose()
        duration_ms = int((time.time() - start_time) * 1000)

        raw_markdown = result.markdown or ""
        sanitized_markdown, injection_flags = sanitize_and_check_injection(raw_markdown)

        # Extract links safely
        links = []
        if hasattr(result, "links") and isinstance(result.links, dict):
            internal = result.links.get("internal", [])
            external = result.links.get("external", [])
            for link in (internal + external)[:100]:
                href = link.get("href", "")
                text = link.get("text", "")
                if href:
                    links.append({"text": text.strip(), "href": href})

        # Extract media safely
        media = []
        if hasattr(result, "media") and isinstance(result.media, dict):
            images = result.media.get("images", [])
            for img in images[:50]:
                src = img.get("src", "")
                alt = img.get("alt", "")
                if src:
                    media.append({"type": "image", "src": src, "alt": alt})

        provenance = {
            "sourceUrl": result.url or url,
            "accessedAt": int(time.time() * 1000),
            "contentHash": compute_hash(sanitized_markdown),
            "documentedVersion": params.get("documentedVersion"),
        }

        # If immediate release requested (to free browser memory), release it
        if params.get("releaseBrowserImmediately"):
            await self.release_browser()

        return {
            "url": url,
            "finalUrl": result.url or url,
            "status": result.status_code if result.status_code is not None else (200 if result.success else 500),
            "success": bool(result.success),
            "markdown": sanitized_markdown,
            "cleanedHtml": result.cleaned_html if params.get("includeCleanedHtml") else None,
            "title": (result.metadata or {}).get("title"),
            "links": links,
            "media": media,
            "metadata": {**(result.metadata or {}), "extractionBackend": "crawl4ai-playwright-async"},
            "cached": getattr(result, "cached", False),
            "sanitized": len(injection_flags) > 0,
            "provenance": provenance,
            "promptInjectionFlags": injection_flags,
            "durationMs": duration_ms,
            "errorMessage": result.error_message if not result.success else None,
        }

    async def handle_discover(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Targeted URL discovery with live DuckDuckGo web search and authoritative source knowledge base.
        """
        import httpx
        import urllib.parse
        from bs4 import BeautifulSoup

        # Keep the caller's spelling for search providers: identifiers such as
        # AbortSignal.timeout can be case-sensitive in provider ranking.
        query = params.get("query", "")
        filter_type = params.get("filterType", "all")
        results = []
        ddg_status = "unavailable"

        # 1. Authoritative curated sources
        RESOURCE_KNOWLEDGE_BASE = [
            # GSAP & Animations
            {
                "title": "GSAP (GreenSock) Official Documentation & React Integration",
                "url": "https://gsap.com/resources/React/",
                "snippet": "Official GreenSock documentation for using GSAP in React with useGSAP hook, timeline controls, and scoped animations.",
                "source": "gsap.com",
                "tags": ["gsap", "animation", "react", "hooks", "docs"],
            },
            {
                "title": "GSAP useGSAP Hook Official API Reference",
                "url": "https://gsap.com/resources/React/#usegsap",
                "snippet": "Detailed API reference for @gsap/react useGSAP hook, automatic animation reversion on unmount, dependencies, and scope refs.",
                "source": "gsap.com",
                "tags": ["usegsap", "gsap", "hook", "cleanup", "docs"],
            },
            # React Bits
            {
                "title": "React Bits — Free Animated React Components",
                "url": "https://reactbits.dev/",
                "snippet": "Collection of animated, interactive React and Tailwind components with copy-paste code snippets and MIT license.",
                "source": "reactbits.dev",
                "tags": ["react bits", "components", "animated", "react", "ui"],
            },
            {
                "title": "React Bits GitHub Repository (DavidHDev/react-bits)",
                "url": "https://github.com/DavidHDev/react-bits",
                "snippet": "Open-source repository of animated React components, design patterns, and creative UI interactions. Permissive MIT license.",
                "source": "github.com",
                "tags": ["react bits", "github", "components", "mit", "animation"],
            },
            # Official React Docs
            {
                "title": "React Official Documentation: Synchronizing with Effects",
                "url": "https://react.dev/learn/synchronizing-with-effects",
                "snippet": "Official guide on how to integrate third-party animation libraries with React lifecycle and cleanups.",
                "source": "react.dev",
                "tags": ["react", "effects", "lifecycle", "cleanup", "docs"],
            },
            # Motion & Tradeoffs
            {
                "title": "Motion (Framer Motion) Documentation",
                "url": "https://motion.dev/",
                "snippet": "Modern declarative animation library for React, supporting layout animations, gestures, and scroll effects.",
                "source": "motion.dev",
                "tags": ["motion", "framer motion", "animation", "react", "docs"],
            },
        ]

        query_tokens = meaningful_search_tokens(query)
        allowed_domains = [str(domain).lower().removeprefix("www.") for domain in params.get("allowedDomains", [])]
        for item in RESOURCE_KNOWLEDGE_BASE:
            if allowed_domains and not any(item["source"].lower() == allowed
                                           or item["source"].lower().endswith("." + allowed)
                                           for allowed in allowed_domains):
                continue
            match_score = curated_match_score(query_tokens, item)
            if match_score > 0:
                results.append((match_score + 10, item))

        # 2. Query DuckDuckGo live search for real-time web discovery
        if query:
            try:
                headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
                async with httpx.AsyncClient(timeout=4.0, headers=headers) as client:
                    resp = await client.post("https://html.duckduckgo.com/html/", data={"q": query})
                    if resp.status_code == 200:
                        soup = BeautifulSoup(resp.text, "html.parser")
                        challenge = ("anomaly-modal" in resp.text.lower() or "challenge-form" in resp.text.lower()
                                     or "select all squares" in resp.text.lower())
                        ddg_status = "challenge" if challenge else "ok"
                        for result_node in soup.select(".result")[:10]:
                            a = result_node.select_one(".result__title a.result__a")
                            if not a:
                                continue
                            title = a.get_text(strip=True)
                            href = a.get("href", "")
                            # Unwrap DuckDuckGo redirect if needed
                            if "uddg=" in href:
                                match = re.search(r"uddg=([^&]+)", href)
                                if match:
                                    href = urllib.parse.unquote(match.group(1))
                            if href and href.startswith("http"):
                                domain = urllib.parse.urlparse(href).netloc
                                if allowed_domains and not any(
                                    domain == allowed.lower().removeprefix("www.")
                                    or domain.endswith("." + allowed.lower().removeprefix("www."))
                                    for allowed in allowed_domains
                                ):
                                    continue
                                snippet_node = result_node.select_one(".result__snippet")
                                snippet = snippet_node.get_text(" ", strip=True) if snippet_node else ""
                                live_item = {
                                    "title": title,
                                    "url": href,
                                    "snippet": snippet,
                                    "source": domain,
                                    "tags": ["web-search", domain],
                                }
                                results.append((5, live_item))
                        if not challenge and not soup.select_one(".result"):
                            ddg_status = "empty"
                    elif resp.status_code in (202, 403, 429) or "challenge" in resp.text[:20_000].lower():
                        ddg_status = "challenge"
            except Exception:
                ddg_status = "unavailable"  # Curated sources remain available; report live-search transport separately.

        # Deduplicate results by URL
        seen_urls = set()
        deduped = []
        results.sort(key=lambda x: x[0], reverse=True)
        for _, item in results:
            if item["url"] not in seen_urls:
                seen_urls.add(item["url"])
                deduped.append(item)

        max_results = params.get("maxResults", 10)
        items = deduped[:max_results]

        return {
            "query": query,
            "items": items,
            "totalMatches": len(items),
            "providerStatus": ddg_status,
        }

    async def close(self):
        if self._closing:
            return
        self._closing = True
        await self.release_browser()

    async def _send_response(self, res: Dict[str, Any]):
        async with self._write_lock:
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

    async def dispatch_request(self, req: Dict[str, Any]):
        req_id = req.get("id")
        action = req.get("action")
        params = req.get("params", {})
        self.last_active = time.time()
        try:
            if action == "ping":
                res = {
                    "id": req_id,
                    "success": True,
                    "data": {
                        "status": "pong",
                        "version": "0.9.4",
                        "timestamp": int(time.time() * 1000),
                        "browserActive": self.crawler is not None,
                    }
                }
            elif action == "crawl":
                data = await self.handle_crawl(params)
                res = {"id": req_id, "success": True, "data": data}
            elif action == "discover":
                data = await self.handle_discover(params)
                res = {"id": req_id, "success": True, "data": data}
            elif action == "memory_metrics":
                mem = get_process_tree_memory()
                mem["browserActive"] = self.crawler is not None
                res = {"id": req_id, "success": True, "data": mem}
            elif action == "release_browser":
                await self.release_browser()
                mem = get_process_tree_memory()
                mem["browserActive"] = False
                res = {"id": req_id, "success": True, "data": mem}
            else:
                res = {"id": req_id, "success": False, "error": f"Unknown action: {action}"}
        except asyncio.CancelledError:
            res = {"id": req_id, "success": False, "error": "Operation cancelled", "cancelled": True}
            await self._send_response(res)
            return
        except Exception as e:
            res = {"id": req_id, "success": False, "error": str(e)}

        await self._send_response(res)

    async def _handle_cancel(self, req: Dict[str, Any]):
        target_id = req.get("params", {}).get("targetRequestId") or req.get("targetRequestId")
        target_task = self._active_requests.get(target_id) if target_id else None

        if not target_task:
            res = {
                "id": req.get("id"),
                "success": True,
                "data": {
                    "cancelled": False,
                    "targetRequestId": target_id,
                    "settled": True,
                    "state": "not_found",
                },
            }
            await self._send_response(res)
            return

        if target_task.done():
            res = {
                "id": req.get("id"),
                "success": True,
                "data": {
                    "cancelled": False,
                    "targetRequestId": target_id,
                    "settled": True,
                    "state": "already_done",
                },
            }
            await self._send_response(res)
            return

        target_task.cancel()
        done, pending = await asyncio.wait([target_task], timeout=5.0)
        is_settled = len(pending) == 0 and target_task.done()

        res = {
            "id": req.get("id"),
            "success": True,
            "data": {
                "cancelled": True,
                "targetRequestId": target_id,
                "settled": is_settled,
                "state": "settled" if is_settled else "pending_cleanup",
            },
        }
        await self._send_response(res)

        if not is_settled:
            async def notify_deferred_cleanup():
                try:
                    await target_task
                except Exception:
                    pass
                await self._send_response({
                    "event": "deferred_settlement",
                    "targetRequestId": target_id,
                    "settled": True
                })
            asyncio.create_task(notify_deferred_cleanup())

    async def run_loop(self):
        await self.initialize()

        # Send ready signal with environment metadata
        await self._send_response({
            "event": "ready",
            "version": "0.9.4",
            "backend": "crawl4ai.AsyncWebCrawler",
            "interpreter": sys.executable,
        })

        loop = asyncio.get_event_loop()

        while not self._closing:
            try:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue

                req = json.loads(line)
                action = req.get("action")
                if action == "shutdown":
                    res = {"id": req.get("id"), "success": True, "data": {"status": "shutting_down"}}
                    await self._send_response(res)
                    break
                elif action == "cancel":
                    # Unblock protocol loop immediately; handle cancellation in background task
                    cancel_task = asyncio.create_task(self._handle_cancel(req))
                    self._active_tasks.add(cancel_task)
                    cancel_task.add_done_callback(self._active_tasks.discard)
                    continue

                req_id = req.get("id")
                task = asyncio.create_task(self.dispatch_request(req))
                if req_id:
                    self._active_requests[req_id] = task
                    task.add_done_callback(lambda t, rid=req_id: self._active_requests.pop(rid, None))
                self._active_tasks.add(task)
                task.add_done_callback(self._active_tasks.discard)

            except Exception as e:
                err_res = {"id": None, "success": False, "error": str(e)}
                await self._send_response(err_res)

        if self._active_tasks:
            await asyncio.gather(*list(self._active_tasks), return_exceptions=True)

        await self.close()

if __name__ == "__main__":
    worker = Crawl4AiWorker()
    try:
        asyncio.run(worker.run_loop())
    except KeyboardInterrupt:
        pass
